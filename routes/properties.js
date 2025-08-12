const express = require('express');
const router = express.Router();
const { query, executeTransaction } = require('../config/db');
const { auth } = require('../middleware/auth');

const safeJsonParse = (str) => {
  try {
    return typeof str === 'string' ? JSON.parse(str) : str;
  } catch (error) {
    console.warn('Error parsing JSON:', error);
    return str || [];
  }
};

router.post('/', auth, async (req, res) => {
  const userId = req.user.id;
  const propertyData = req.body;

  console.log('Received property data:', propertyData);

  if (!propertyData || typeof propertyData !== 'object') {
    return res.status(400).json({
      error: 'Invalid data',
      message: 'Property data is required'
    });
  }

  const requiredFields = ['property_type', 'unit_type', 'address', 'price'];
  const missingFields = requiredFields.filter(field => !propertyData[field]);

  if (missingFields.length > 0) {
    return res.status(400).json({
      error: 'Missing required fields',
      message: `Required fields are missing: ${missingFields.join(', ')}`
    });
  }

  if (isNaN(parseFloat(propertyData.price)) || parseFloat(propertyData.price) <= 0) {
    return res.status(400).json({
      error: 'Invalid price',
      message: 'Price must be a positive number'
    });
  }

  if (!propertyData.images || !Array.isArray(propertyData.images) || propertyData.images.length === 0) {
    return res.status(400).json({
      error: 'No images provided',
      message: 'At least one image is required'
    });
  }

  try {
    const price = parseFloat(propertyData.price);
    const bedrooms = parseInt(propertyData.bedrooms) || 0;
    const bathrooms = parseInt(propertyData.bathrooms) || 0;

    let amenities = [];
    let facilities = [];
    let images = [];

    if (propertyData.images && Array.isArray(propertyData.images)) {
      images = propertyData.images.map(img => {
        if (typeof img === 'string') {
          return { url: img, filename: '', size: 0 };
        }
        return {
          url: img.url || img,
          filename: img.filename || '',
          size: img.size || 0
        };
      });
    }

    if (propertyData.amenities) {
      amenities = Array.isArray(propertyData.amenities) ? 
                  propertyData.amenities : 
                  propertyData.amenities.split(',').map(a => a.trim());
    }

    if (propertyData.facilities) {
      facilities = Array.isArray(propertyData.facilities) ? 
                   propertyData.facilities : 
                   propertyData.facilities.split(',').map(f => f.trim());
    }

    const priceRange = {
      min: price,
      max: price,
      currency: 'LKR'
    };

    const billsInclusive = propertyData.bills_inclusive || [];

    const queries = [
      {
        sql: `INSERT INTO all_properties (
          user_id, property_type, unit_type, address, price, amenities, facilities, 
          images, description, bedrooms, bathrooms, available_from, available_to,
          is_active, approval_status, views_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', 0, NOW(), NOW())`,
        params: [
          userId,
          propertyData.property_type,
          propertyData.unit_type,
          propertyData.address,
          price,
          JSON.stringify(amenities),
          JSON.stringify(facilities),
          JSON.stringify(images),
          propertyData.description || null,
          bedrooms,
          bathrooms,
          propertyData.available_from || null,
          propertyData.available_to || null
        ]
      },
      {
        sql: `INSERT INTO property_details (
          user_id, property_type, unit_type, amenities, facilities, 
          address, available_from, available_to, price_range, bills_inclusive,
          approval_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW(), NOW())`,
        params: [
          userId,
          propertyData.property_type,
          propertyData.unit_type,
          JSON.stringify(amenities),
          JSON.stringify(facilities),
          propertyData.address,
          propertyData.available_from || null,
          propertyData.available_to || null,
          JSON.stringify(priceRange),
          JSON.stringify(billsInclusive)
        ]
      }
    ];

    const results = await executeTransaction(queries);
    const newPropertyId = results[0].insertId;

    const newProperty = await query(
      'SELECT * FROM all_properties WHERE id = ?',
      [newPropertyId]
    );

    const processedProperty = {
      ...newProperty[0],
      price: parseFloat(newProperty[0].price),
      amenities: safeJsonParse(newProperty[0].amenities),
      facilities: safeJsonParse(newProperty[0].facilities),
      images: safeJsonParse(newProperty[0].images)
    };

    res.status(201).json({
      success: true,
      message: 'Property created successfully and submitted for approval',
      property: processedProperty,
      status: 'pending_approval'
    });

  } catch (error) {
    console.error('Error creating property:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to create property. Please try again.'
    });
  }
});

router.put('/:id', auth, async (req, res) => {
  const propertyId = req.params.id;
  const userId = req.user.id;
  const userRole = req.user.role;
  const updateData = req.body;

  if (!propertyId || isNaN(propertyId)) {
    return res.status(400).json({
      error: 'Invalid property ID',
      message: 'Property ID must be a valid number'
    });
  }

  try {
    const existingProperty = await query(
      'SELECT id, user_id, approval_status FROM all_properties WHERE id = ?',
      [propertyId]
    );

    if (existingProperty.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'The specified property could not be found'
      });
    }

    const property = existingProperty[0];

    if (userRole !== 'admin' && property.user_id !== userId) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You can only update your own properties'
      });
    }

    const allowedFields = [
      'unit_type', 'address', 'price', 'description', 'amenities', 'facilities',
      'images', 'bedrooms', 'bathrooms', 'available_from', 'available_to',
      'is_active', 'approval_status'
    ];

    const updates = {};
    const params = [];
    const setParts = [];

    Object.keys(updateData).forEach(key => {
      if (allowedFields.includes(key) && updateData[key] !== undefined) {
        if (key === 'price') {
          const price = parseFloat(updateData[key]);
          if (isNaN(price) || price <= 0) {
            throw new Error('Price must be a positive number');
          }
          updates[key] = price;
        } else if (key === 'bedrooms' || key === 'bathrooms') {
          updates[key] = parseInt(updateData[key]) || 0;
        } else if (key === 'amenities' || key === 'facilities' || key === 'images') {
          const value = Array.isArray(updateData[key]) ? 
                       updateData[key] : 
                       (typeof updateData[key] === 'string' ? 
                        updateData[key].split(',').map(item => item.trim()) : 
                        []);
          updates[key] = JSON.stringify(value);
        } else {
          updates[key] = updateData[key];
        }
        
        setParts.push(`${key} = ?`);
        params.push(updates[key]);
      }
    });

    if (setParts.length === 0) {
      return res.status(400).json({
        error: 'No valid fields to update',
        message: 'No valid update fields provided'
      });
    }

    setParts.push('updated_at = NOW()');
    params.push(propertyId);

    const allPropsQuery = `
      UPDATE all_properties 
      SET ${setParts.join(', ')} 
      WHERE id = ?
    `;

    const queries = [
      {
        sql: allPropsQuery,
        params: params
      }
    ];

    const propertyDetailsExists = await query(
      'SELECT id FROM property_details WHERE user_id = ?',
      [property.user_id]
    );

    if (propertyDetailsExists.length > 0) {
      const detailsUpdates = {};
      const detailsParams = [];
      const detailsSetParts = [];
      
      ['property_type', 'unit_type', 'amenities', 'facilities', 'address', 'available_from', 'available_to'].forEach(field => {
        if (updates[field] !== undefined) {
          detailsSetParts.push(`${field} = ?`);
          detailsParams.push(updates[field]);
        }
      });

      if (updates.price !== undefined) {
        const priceRange = {
          min: updates.price,
          max: updates.price,
          currency: 'LKR'
        };
        detailsSetParts.push('price_range = ?');
        detailsParams.push(JSON.stringify(priceRange));
      }

      if (updates.approval_status !== undefined) {
        detailsSetParts.push('approval_status = ?');
        detailsParams.push(updates.approval_status);
      }

      if (detailsSetParts.length > 0) {
        detailsSetParts.push('updated_at = NOW()');
        detailsParams.push(property.user_id);
        
        queries.push({
          sql: `UPDATE property_details SET ${detailsSetParts.join(', ')} WHERE user_id = ?`,
          params: detailsParams
        });
      }
    }

    await executeTransaction(queries);

    const updatedProperty = await query(
      'SELECT * FROM all_properties WHERE id = ?',
      [propertyId]
    );

    const processedProperty = {
      ...updatedProperty[0],
      price: parseFloat(updatedProperty[0].price),
      amenities: safeJsonParse(updatedProperty[0].amenities),
      facilities: safeJsonParse(updatedProperty[0].facilities),
      images: safeJsonParse(updatedProperty[0].images)
    };

    res.json({
      message: 'Property updated successfully',
      property: processedProperty
    });

  } catch (error) {
    console.error('Error updating property:', error);
    
    if (error.message.includes('Price must be')) {
      return res.status(400).json({
        error: 'Invalid data',
        message: error.message
      });
    }
    
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to update property. Please try again.'
    });
  }
});

router.delete('/:id', auth, async (req, res) => {
  const propertyId = req.params.id;
  const userId = req.user.id;
  const userRole = req.user.role;

  if (!propertyId || isNaN(propertyId)) {
    return res.status(400).json({
      error: 'Invalid property ID',
      message: 'Property ID must be a valid number'
    });
  }

  try {
    const existingProperty = await query(
      'SELECT id, user_id FROM all_properties WHERE id = ?',
      [propertyId]
    );

    if (existingProperty.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'The specified property could not be found'
      });
    }

    const property = existingProperty[0];

    if (userRole !== 'admin' && property.user_id !== userId) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You can only delete your own properties'
      });
    }

    const queries = [
      {
        sql: 'DELETE FROM all_properties WHERE id = ?',
        params: [propertyId]
      }
    ];

    const propertyDetailsExists = await query(
      'SELECT id FROM property_details WHERE user_id = ?',
      [property.user_id]
    );

    if (propertyDetailsExists.length > 0) {
      queries.push({
        sql: 'DELETE FROM property_details WHERE user_id = ?',
        params: [property.user_id]
      });
    }

    await executeTransaction(queries);

    res.json({
      message: 'Property deleted successfully',
      propertyId: propertyId
    });

  } catch (error) {
    console.error('Error deleting property:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to delete property. Please try again.'
    });
  }
});

router.get('/', auth, async (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;

  if (userRole !== 'propertyowner' && userRole !== 'admin') {
    return res.status(403).json({
      error: 'Access denied',
      message: 'Only property owners can access this endpoint'
    });
  }

  try {
    const { 
      page = 1, 
      limit = 10, 
      status, 
      approval_status,
      search,
      sort_by = 'created_at',
      sort_order = 'DESC'
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    let whereClause = '';
    const params = [];

    if (userRole === 'admin') {
      whereClause = 'WHERE 1=1';
    } else {
      whereClause = 'WHERE user_id = ?';
      params.push(userId);
    }

    if (status) {
      whereClause += ' AND is_active = ?';
      params.push(status === 'active' ? 1 : 0);
    }

    if (approval_status) {
      whereClause += ' AND approval_status = ?';
      params.push(approval_status);
    }

    if (search) {
      whereClause += ' AND (address LIKE ? OR property_type LIKE ? OR unit_type LIKE ?)';
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }

    const allowedSortFields = ['created_at', 'updated_at', 'price', 'views_count'];
    const sortField = allowedSortFields.includes(sort_by) ? sort_by : 'created_at';
    const sortDirection = sort_order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const propertiesQuery = `
      SELECT 
        p.*,
        u.username as owner_name,
        u.email as owner_email
      FROM all_properties p
      LEFT JOIN users u ON p.user_id = u.id
      ${whereClause}
      ORDER BY ${sortField} ${sortDirection}
      LIMIT ? OFFSET ?
    `;

    const countQuery = `
      SELECT COUNT(*) as total FROM all_properties p
      LEFT JOIN users u ON p.user_id = u.id
      ${whereClause}
    `;

    const [properties, countResult] = await Promise.all([
      query(propertiesQuery, [...params, parseInt(limit), offset]),
      query(countQuery, params)
    ]);

    const processedProperties = properties.map(property => ({
      ...property,
      price: parseFloat(property.price),
      amenities: safeJsonParse(property.amenities),
      facilities: safeJsonParse(property.facilities),
      images: safeJsonParse(property.images)
    }));

    const total = countResult[0].total;
    const totalPages = Math.ceil(total / parseInt(limit));

    res.json({
      properties: processedProperties,
      pagination: {
        current_page: parseInt(page),
        total_pages: totalPages,
        total_items: total,
        items_per_page: parseInt(limit),
        has_next: parseInt(page) < totalPages,
        has_prev: parseInt(page) > 1
      }
    });

  } catch (error) {
    console.error('Error fetching user properties:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch properties. Please try again.'
    });
  }
});

router.get('/owner/mine', auth, async (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;

  if (userRole !== 'propertyowner' && userRole !== 'admin') {
    return res.status(403).json({
      error: 'Access denied',
      message: 'Only property owners can access this endpoint'
    });
  }

  try {
    const { 
      page = 1, 
      limit = 10, 
      status, 
      approval_status,
      search,
      sort_by = 'created_at',
      sort_order = 'DESC'
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    let whereClause = 'WHERE user_id = ?';
    const params = [userId];

    if (status) {
      whereClause += ' AND is_active = ?';
      params.push(status === 'active' ? 1 : 0);
    }

    if (approval_status) {
      whereClause += ' AND approval_status = ?';
      params.push(approval_status);
    }

    if (search) {
      whereClause += ' AND (address LIKE ? OR property_type LIKE ? OR unit_type LIKE ?)';
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }

    const allowedSortFields = ['created_at', 'updated_at', 'price', 'views_count'];
    const sortField = allowedSortFields.includes(sort_by) ? sort_by : 'created_at';
    const sortDirection = sort_order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const propertiesQuery = `
      SELECT * FROM all_properties 
      ${whereClause}
      ORDER BY ${sortField} ${sortDirection}
      LIMIT ? OFFSET ?
    `;

    const countQuery = `
      SELECT COUNT(*) as total FROM all_properties ${whereClause}
    `;

    const [properties, countResult] = await Promise.all([
      query(propertiesQuery, [...params, parseInt(limit), offset]),
      query(countQuery, params)
    ]);

    const processedProperties = properties.map(property => ({
      ...property,
      price: parseFloat(property.price),
      amenities: safeJsonParse(property.amenities),
      facilities: safeJsonParse(property.facilities),
      images: safeJsonParse(property.images)
    }));

    const total = countResult[0].total;
    const totalPages = Math.ceil(total / parseInt(limit));

    res.json({
      properties: processedProperties,
      pagination: {
        current_page: parseInt(page),
        total_pages: totalPages,
        total_items: total,
        items_per_page: parseInt(limit),
        has_next: parseInt(page) < totalPages,
        has_prev: parseInt(page) > 1
      }
    });

  } catch (error) {
    console.error('Error fetching user properties:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch properties. Please try again.'
    });
  }
});

router.get('/admin/all', auth, async (req, res) => {
  const userRole = req.user.role;

  if (userRole !== 'admin') {
    return res.status(403).json({
      error: 'Access denied',
      message: 'Only admins can access this endpoint'
    });
  }

  try {
    const { 
      page = 1, 
      limit = 20, 
      status, 
      approval_status,
      search,
      owner_id,
      sort_by = 'created_at',
      sort_order = 'DESC'
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    let whereClause = 'WHERE 1=1';
    const params = [];

    if (status && status !== 'all') {
      whereClause += ' AND p.is_active = ?';
      params.push(status === 'active' ? 1 : 0);
    }

    if (approval_status && approval_status !== 'all') {
      whereClause += ' AND p.approval_status = ?';
      params.push(approval_status);
    }

    if (owner_id) {
      whereClause += ' AND p.user_id = ?';
      params.push(parseInt(owner_id));
    }

    if (search) {
      whereClause += ' AND (p.address LIKE ? OR p.property_type LIKE ? OR p.unit_type LIKE ? OR u.username LIKE ?)';
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    const allowedSortFields = ['created_at', 'updated_at', 'price', 'views_count', 'approval_status'];
    const sortField = allowedSortFields.includes(sort_by) ? `p.${sort_by}` : 'p.created_at';
    const sortDirection = sort_order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const propertiesQuery = `
      SELECT 
        p.*,
        u.username as owner_name,
        u.email as owner_email,
        up.business_name as owner_business_name,
        up.phone as owner_phone
      FROM all_properties p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN user_profiles up ON u.id = up.user_id
      ${whereClause}
      ORDER BY ${sortField} ${sortDirection}
      LIMIT ? OFFSET ?
    `;

    const countQuery = `
      SELECT COUNT(*) as total FROM all_properties p
      LEFT JOIN users u ON p.user_id = u.id
      ${whereClause}
    `;

    const [properties, countResult] = await Promise.all([
      query(propertiesQuery, [...params, parseInt(limit), offset]),
      query(countQuery, params)
    ]);

    const processedProperties = properties.map(property => ({
      ...property,
      price: parseFloat(property.price),
      amenities: safeJsonParse(property.amenities),
      facilities: safeJsonParse(property.facilities),
      images: safeJsonParse(property.images),
      owner_info: {
        username: property.owner_name,
        email: property.owner_email,
        business_name: property.owner_business_name,
        phone: property.owner_phone
      }
    }));

    processedProperties.forEach(property => {
      delete property.owner_name;
      delete property.owner_email;
      delete property.owner_business_name;
      delete property.owner_phone;
    });

    const total = countResult[0].total;
    const totalPages = Math.ceil(total / parseInt(limit));

    const statusCounts = await query(`
      SELECT 
        approval_status,
        COUNT(*) as count
      FROM all_properties 
      GROUP BY approval_status
    `);

    const stats = {
      total: total,
      pending: statusCounts.find(s => s.approval_status === 'pending')?.count || 0,
      approved: statusCounts.find(s => s.approval_status === 'approved')?.count || 0,
      rejected: statusCounts.find(s => s.approval_status === 'rejected')?.count || 0
    };

    res.json({
      properties: processedProperties,
      pagination: {
        current_page: parseInt(page),
        total_pages: totalPages,
        total_items: total,
        items_per_page: parseInt(limit),
        has_next: parseInt(page) < totalPages,
        has_prev: parseInt(page) > 1
      },
      stats: stats,
      filters_applied: {
        status,
        approval_status,
        search,
        owner_id
      }
    });

  } catch (error) {
    console.error('Error fetching admin properties:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch properties. Please try again.'
    });
  }
});

router.get('/public', async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 12, 
      property_type,
      unit_type,
      min_price,
      max_price,
      location,
      amenities,
      bedrooms,
      bathrooms,
      sort_by = 'created_at',
      sort_order = 'DESC'
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    let whereClause = 'WHERE is_active = 1 AND approval_status = "approved"';
    const params = [];

    if (property_type) {
      whereClause += ' AND property_type = ?';
      params.push(property_type);
    }

    if (unit_type) {
      whereClause += ' AND unit_type = ?';
      params.push(unit_type);
    }

    if (min_price) {
      whereClause += ' AND price >= ?';
      params.push(parseFloat(min_price));
    }

    if (max_price) {
      whereClause += ' AND price <= ?';
      params.push(parseFloat(max_price));
    }

    if (location) {
      whereClause += ' AND address LIKE ?';
      params.push(`%${location}%`);
    }

    if (bedrooms) {
      whereClause += ' AND bedrooms >= ?';
      params.push(parseInt(bedrooms));
    }

    if (bathrooms) {
      whereClause += ' AND bathrooms >= ?';
      params.push(parseInt(bathrooms));
    }

    const allowedSortFields = ['created_at', 'updated_at', 'price', 'views_count'];
    const sortField = allowedSortFields.includes(sort_by) ? sort_by : 'created_at';
    const sortDirection = sort_order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const propertiesQuery = `
      SELECT 
        p.*,
        u.username as owner_name,
        u.email as owner_email
      FROM all_properties p
      LEFT JOIN users u ON p.user_id = u.id
      ${whereClause}
      ORDER BY ${sortField} ${sortDirection}
      LIMIT ? OFFSET ?
    `;

    const countQuery = `
      SELECT COUNT(*) as total FROM all_properties p ${whereClause}
    `;

    const [properties, countResult] = await Promise.all([
      query(propertiesQuery, [...params, parseInt(limit), offset]),
      query(countQuery, params)
    ]);

    let filteredProperties = properties;

    if (amenities) {
      const requiredAmenities = Array.isArray(amenities) ? amenities : [amenities];
      filteredProperties = properties.filter(property => {
        const propertyAmenities = safeJsonParse(property.amenities);
        return requiredAmenities.every(amenity => 
          propertyAmenities.some(pAmenity => 
            pAmenity.toLowerCase().includes(amenity.toLowerCase())
          )
        );
      });
    }

    const processedProperties = filteredProperties.map(property => ({
      ...property,
      price: parseFloat(property.price),
      amenities: safeJsonParse(property.amenities),
      facilities: safeJsonParse(property.facilities),
      images: safeJsonParse(property.images)
    }));

    const total = countResult[0].total;
    const totalPages = Math.ceil(total / parseInt(limit));

    res.json({
      properties: processedProperties,
      pagination: {
        current_page: parseInt(page),
        total_pages: totalPages,
        total_items: total,
        items_per_page: parseInt(limit),
        has_next: parseInt(page) < totalPages,
        has_prev: parseInt(page) > 1
      },
      filters_applied: {
        property_type,
        unit_type,
        price_range: { min: min_price, max: max_price },
        location,
        amenities,
        bedrooms,
        bathrooms
      }
    });

  } catch (error) {
    console.error('Error fetching public properties:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch properties. Please try again.'
    });
  }
});

router.get('/public/:id', async (req, res) => {
  const propertyId = req.params.id;

  if (!propertyId || isNaN(propertyId)) {
    return res.status(400).json({
      error: 'Invalid property ID',
      message: 'Property ID must be a valid number'
    });
  }

  try {
    const authHeader = req.headers.authorization;
    let currentUserId = null;
    let currentUserRole = null;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      try {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret_key');
        currentUserId = decoded.user?.id || decoded.id;
        currentUserRole = decoded.user?.role;
        console.log('Authenticated user ID:', currentUserId, 'Role:', currentUserRole);
      } catch (jwtError) {
        console.log('JWT verification failed:', jwtError.message);
      }
    }

    let propertyQuery;
    let queryParams;

    if (currentUserId) {
      if (currentUserRole === 'admin') {
        propertyQuery = `
          SELECT 
            p.*,
            u.username as owner_name,
            u.email as owner_email,
            prof.phone as owner_phone,
            prof.first_name as owner_first_name,
            prof.last_name as owner_last_name
          FROM all_properties p
          LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN user_profiles prof ON u.id = prof.user_id
          WHERE p.id = ?
        `;
        queryParams = [propertyId];
      } else {
        propertyQuery = `
          SELECT 
            p.*,
            u.username as owner_name,
            u.email as owner_email,
            prof.phone as owner_phone,
            prof.first_name as owner_first_name,
            prof.last_name as owner_last_name
          FROM all_properties p
          LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN user_profiles prof ON u.id = prof.user_id
          WHERE p.id = ? AND p.is_active = 1 
            AND (p.approval_status = 'approved' OR p.user_id = ?)
        `;
        queryParams = [propertyId, currentUserId];
      }
    } else {
      propertyQuery = `
        SELECT 
          p.*,
          u.username as owner_name,
          u.email as owner_email,
          prof.phone as owner_phone,
          prof.first_name as owner_first_name,
          prof.last_name as owner_last_name
        FROM all_properties p
        LEFT JOIN users u ON p.user_id = u.id
        LEFT JOIN user_profiles prof ON u.id = prof.user_id
        WHERE p.id = ? AND p.is_active = 1 AND p.approval_status = 'approved'
      `;
      queryParams = [propertyId];
    }

    console.log('Executing query for property:', propertyId, 'with user:', currentUserId);
    const properties = await query(propertyQuery, queryParams);

    if (properties.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'The requested property could not be found or is not available'
      });
    }

    await query(
      'UPDATE all_properties SET views_count = views_count + 1 WHERE id = ?',
      [propertyId]
    );

    const property = properties[0];
    const processedProperty = {
      ...property,
      price: parseFloat(property.price),
      amenities: safeJsonParse(property.amenities),
      facilities: safeJsonParse(property.facilities),
      images: safeJsonParse(property.images)
    };

    res.json(processedProperty);

  } catch (error) {
    console.error('Error fetching property details:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch property details. Please try again.'
    });
  }
});

router.get('/:id', auth, async (req, res) => {
  const propertyId = req.params.id;
  const userId = req.user.id;
  const userRole = req.user.role;

  if (!propertyId || isNaN(propertyId)) {
    return res.status(400).json({
      error: 'Invalid property ID',
      message: 'Property ID must be a valid number'
    });
  }

  try {
    const propertyQuery = `
      SELECT 
        p.*,
        u.username as owner_name,
        u.email as owner_email
      FROM all_properties p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.id = ?
    `;

    const properties = await query(propertyQuery, [propertyId]);

    if (properties.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'The specified property could not be found'
      });
    }

    const property = properties[0];

    if (userRole !== 'admin' && property.user_id !== userId) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You can only access your own properties'
      });
    }

    const processedProperty = {
      ...property,
      price: parseFloat(property.price),
      amenities: safeJsonParse(property.amenities),
      facilities: safeJsonParse(property.facilities),
      images: safeJsonParse(property.images)
    };

    res.json(processedProperty);

  } catch (error) {
    console.error('Error fetching property:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch property. Please try again.'
    });
  }
});

router.patch('/:id/status', auth, async (req, res) => {
  const propertyId = req.params.id;
  const userId = req.user.id;
  const userRole = req.user.role;
  const { is_active, approval_status } = req.body;

  if (!propertyId || isNaN(propertyId)) {
    return res.status(400).json({
      error: 'Invalid property ID',
      message: 'Property ID must be a valid number'
    });
  }

  try {
    const existingProperty = await query(
      'SELECT id, user_id, approval_status FROM all_properties WHERE id = ?',
      [propertyId]
    );

    if (existingProperty.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'The specified property could not be found'
      });
    }

    const property = existingProperty[0];

    if (userRole !== 'admin' && property.user_id !== userId) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You can only modify your own properties'
      });
    }

    const updates = {};
    const allPropsSetParts = [];
    const allPropsParams = [];

    if (is_active !== undefined) {
      updates.is_active = Boolean(is_active);
      allPropsSetParts.push('is_active = ?');
      allPropsParams.push(updates.is_active ? 1 : 0);
    }

    if (approval_status !== undefined && userRole === 'admin') {
      const validStatuses = ['pending', 'approved', 'rejected'];
      if (validStatuses.includes(approval_status)) {
        updates.approval_status = approval_status;
        allPropsSetParts.push('approval_status = ?');
        allPropsParams.push(approval_status);
      }
    }

    if (allPropsSetParts.length === 0) {
      return res.status(400).json({
        error: 'No valid fields to update',
        message: 'No valid status fields provided'
      });
    }

    allPropsSetParts.push('updated_at = NOW()');
    allPropsParams.push(propertyId);

    const queries = [
      {
        sql: `UPDATE all_properties SET ${allPropsSetParts.join(', ')} WHERE id = ?`,
        params: allPropsParams
      }
    ];

    const propertyDetailsExists = await query(
      'SELECT id FROM property_details WHERE user_id = ?',
      [property.user_id]
    );

    if (propertyDetailsExists.length > 0 && updates.approval_status) {
      queries.push({
        sql: 'UPDATE property_details SET approval_status = ?, updated_at = NOW() WHERE user_id = ?',
        params: [updates.approval_status, property.user_id]
      });
    }

    await executeTransaction(queries);

    const updatedProperty = await query(
      'SELECT * FROM all_properties WHERE id = ?',
      [propertyId]
    );

    const processedProperty = {
      ...updatedProperty[0],
      price: parseFloat(updatedProperty[0].price),
      amenities: safeJsonParse(updatedProperty[0].amenities),
      facilities: safeJsonParse(updatedProperty[0].facilities),
      images: safeJsonParse(updatedProperty[0].images)
    };

    res.json({
      message: 'Property status updated successfully',
      property: processedProperty,
      updates: updates
    });

  } catch (error) {
    console.error('Error updating property status:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to update property status. Please try again.'
    });
  }
});

router.patch('/:id/approve', auth, async (req, res) => {
  const propertyId = req.params.id;
  const userId = req.user.id;
  const userRole = req.user.role;
  const { approval_reason } = req.body;

  if (userRole !== 'admin') {
    return res.status(403).json({
      error: 'Access denied',
      message: 'Only admins can approve properties'
    });
  }

  if (!propertyId || isNaN(propertyId)) {
    return res.status(400).json({
      error: 'Invalid property ID',
      message: 'Property ID must be a valid number'
    });
  }

  try {
    const existingProperty = await query(
      'SELECT id, user_id, approval_status FROM all_properties WHERE id = ?',
      [propertyId]
    );

    if (existingProperty.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'The specified property could not be found'
      });
    }

    const property = existingProperty[0];

    const queries = [
      {
        sql: 'UPDATE all_properties SET approval_status = ?, is_active = 1, updated_at = NOW() WHERE id = ?',
        params: ['approved', propertyId]
      }
    ];

    const propertyDetailsExists = await query(
      'SELECT id FROM property_details WHERE user_id = ?',
      [property.user_id]
    );

    if (propertyDetailsExists.length > 0) {
      queries.push({
        sql: 'UPDATE property_details SET approval_status = ?, approval_reason = ?, approved_by = ?, approved_at = NOW(), updated_at = NOW() WHERE user_id = ?',
        params: ['approved', approval_reason || 'Property approved by admin', userId, property.user_id]
      });
    }

    await executeTransaction(queries);

    res.json({
      message: 'Property approved successfully',
      property_id: parseInt(propertyId),
      approved_by: req.user.username,
      approved_at: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error approving property:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to approve property. Please try again.'
    });
  }
});

router.patch('/:id/reject', auth, async (req, res) => {
  const propertyId = req.params.id;
  const userId = req.user.id;
  const userRole = req.user.role;
  const { rejection_reason } = req.body;

  if (userRole !== 'admin') {
    return res.status(403).json({
      error: 'Access denied',
      message: 'Only admins can reject properties'
    });
  }

  if (!propertyId || isNaN(propertyId)) {
    return res.status(400).json({
      error: 'Invalid property ID',
      message: 'Property ID must be a valid number'
    });
  }

  if (!rejection_reason || rejection_reason.trim().length < 10) {
    return res.status(400).json({
      error: 'Rejection reason required',
      message: 'Please provide a detailed rejection reason (at least 10 characters)'
    });
  }

  try {
    const existingProperty = await query(
      'SELECT id, user_id, approval_status FROM all_properties WHERE id = ?',
      [propertyId]
    );

    if (existingProperty.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'The specified property could not be found'
      });
    }

    const property = existingProperty[0];

    const queries = [
      {
        sql: 'UPDATE all_properties SET approval_status = ?, is_active = 0, updated_at = NOW() WHERE id = ?',
        params: ['rejected', propertyId]
      }
    ];

    const propertyDetailsExists = await query(
      'SELECT id FROM property_details WHERE user_id = ?',
      [property.user_id]
    );

    if (propertyDetailsExists.length > 0) {
      queries.push({
        sql: 'UPDATE property_details SET approval_status = ?, rejected_reason = ?, approved_by = ?, updated_at = NOW() WHERE user_id = ?',
        params: ['rejected', rejection_reason, userId, property.user_id]
      });
    }

    await executeTransaction(queries);

    res.json({
      message: 'Property rejected successfully',
      property_id: parseInt(propertyId),
      rejection_reason: rejection_reason,
      rejected_by: req.user.username,
      rejected_at: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error rejecting property:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to reject property. Please try again.'
    });
  }
});

module.exports = router;