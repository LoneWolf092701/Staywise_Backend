const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const auth = require('../middleware/auth');

const safeJsonParse = (jsonString, defaultValue = {}) => {
  if (!jsonString) return defaultValue;
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    console.warn('JSON parse error:', error);
    return defaultValue;
  }
};

const safeJsonStringify = (obj) => {
  if (!obj) return '{}';
  try {
    return JSON.stringify(obj);
  } catch (error) {
    console.warn('JSON stringify error:', error);
    return '{}';
  }
};

router.post('/', auth, requireRole(['propertyowner']), validateProperty, async (req, res) => {
  const userId = req.user.id;
  
  try {
    const {
      property_type,
      unit_type,
      address,
      price,
      amenities,
      facilities,
      images,
      description,
      available_from,
      available_to,
      rules,               
      roommates,            
      contract_policy,  
      other_facility,
      bills_inclusive
    } = req.body;

    const queries = [
      {
        sql: `INSERT INTO all_properties (
          user_id, property_type, unit_type, address, price, amenities, facilities, 
          images, description, bedrooms, bathrooms, available_from, available_to,
          is_active, approval_status, views_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', 0, NOW(), NOW())`,
        params: [
          userId, property_type, unit_type, address, price,
          JSON.stringify(amenities || {}),
          JSON.stringify(facilities || {}),
          JSON.stringify(images || []),
          description || null,
          facilities?.Bedroom || 0,
          facilities?.Bathroom || 0,
          available_from || null,
          available_to || null
        ]
      },
      {
        sql: `INSERT INTO property_details (
          user_id, property_type, unit_type, amenities, facilities, 
          address, available_from, available_to, price_range, bills_inclusive,
          rules, roommates, contract_policy, other_facility,
          approval_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW(), NOW())`,
        params: [
          userId, property_type, unit_type,
          JSON.stringify(amenities || {}),
          JSON.stringify(facilities || {}),
          address,
          available_from || null,
          available_to || null,
          JSON.stringify({ min: price, max: price, currency: 'LKR' }),
          JSON.stringify(bills_inclusive || []),
          JSON.stringify(rules || []),           
          JSON.stringify(roommates || []),      
          contract_policy || null,             
          other_facility || null
        ]
      }
    ];

    const results = await executeTransaction(queries);
    const newPropertyId = results[0].insertId;

    const newProperty = await query(
      'SELECT * FROM all_properties WHERE id = ?',
      [newPropertyId]
    );

    res.status(201).json({
      message: 'Property created successfully',
      property: newProperty[0]
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
  
  try {
    const property = await query(
      'SELECT user_id FROM all_properties WHERE id = ?',
      [propertyId]
    );

    if (property.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'The property you are trying to update does not exist'
      });
    }

    if (userRole !== 'admin' && property[0].user_id !== userId) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You can only update your own properties'
      });
    }

    const {
      property_type,
      unit_type,
      address,
      price,
      amenities,
      facilities,
      description,
      available_from,
      available_to,
      rules,               
      roommates,           
      contract_policy,     
      other_facility,
      bills_inclusive
    } = req.body;

    const queries = [
      {
        sql: `UPDATE all_properties SET 
          property_type = ?, unit_type = ?, address = ?, price = ?, 
          amenities = ?, facilities = ?, description = ?, 
          bedrooms = ?, bathrooms = ?, available_from = ?, available_to = ?,
          updated_at = NOW()
          WHERE id = ?`,
        params: [
          property_type, unit_type, address, price,
          JSON.stringify(amenities || {}),
          JSON.stringify(facilities || {}),
          description,
          facilities?.Bedroom || 0,
          facilities?.Bathroom || 0,
          available_from,
          available_to,
          propertyId
        ]
      },
      {
        sql: `UPDATE property_details SET 
          property_type = ?, unit_type = ?, amenities = ?, facilities = ?,
          address = ?, available_from = ?, available_to = ?, 
          price_range = ?, bills_inclusive = ?,
          rules = ?, roommates = ?, contract_policy = ?, other_facility = ?,
          updated_at = NOW()
          WHERE user_id = ?`,
        params: [
          property_type, unit_type,
          JSON.stringify(amenities || {}),
          JSON.stringify(facilities || {}),
          address, available_from, available_to,
          JSON.stringify({ min: price, max: price, currency: 'LKR' }),
          JSON.stringify(bills_inclusive || []),
          JSON.stringify(rules || []),           
          JSON.stringify(roommates || []),       
          contract_policy || null,             
          other_facility || null,
          property[0].user_id
        ]
      }
    ];

    await executeTransaction(queries);

    const updatedProperty = await query(
      'SELECT * FROM all_properties WHERE id = ?',
      [propertyId]
    );

    res.json({
      message: 'Property updated successfully',
      property: updatedProperty[0]
    });

  } catch (error) {
    console.error('Error updating property:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to update property. Please try again.'
    });
  }
});

router.get('/owner/mine', auth, async (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;

  if (userRole !== 'propertyowner') {
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

    if (status && status !== 'all') {
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
      images: safeJsonParse(property.images),
      rules: safeJsonParse(property.rules, []),
      roommates: safeJsonParse(property.roommates, [])
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

router.get('/public/:id', async (req, res) => {
  const propertyId = req.params.id;
  
  try {
    const property = await query(`
      SELECT 
        ap.*,
        pd.rules,
        pd.roommates,
        pd.contract_policy,
        pd.other_facility,
        pd.bills_inclusive,
        u.username as owner_name,
        u.email as owner_email,
        up.phone as owner_phone,
        up.business_name
      FROM all_properties ap
      LEFT JOIN property_details pd ON ap.user_id = pd.user_id
      LEFT JOIN users u ON ap.user_id = u.id
      LEFT JOIN user_profiles up ON ap.user_id = up.user_id
      WHERE ap.id = ? AND ap.is_active = 1 AND ap.approval_status = 'approved'
    `, [propertyId]);

    if (property.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'Property not found or not available'
      });
    }

    await query(
      'UPDATE all_properties SET views_count = views_count + 1 WHERE id = ?',
      [propertyId]
    );

    res.json(property[0]);
  } catch (error) {
    console.error('Error fetching property:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch property details'
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
      images: safeJsonParse(property.images),
      rules: safeJsonParse(property.rules, []),
      roommates: safeJsonParse(property.roommates, [])
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
      if (!validStatuses.includes(approval_status)) {
        return res.status(400).json({
          error: 'Invalid approval status',
          message: 'Approval status must be one of: pending, approved, rejected'
        });
      }
      updates.approval_status = approval_status;
      allPropsSetParts.push('approval_status = ?');
      allPropsParams.push(approval_status);
    }

    if (allPropsSetParts.length === 0) {
      return res.status(400).json({
        error: 'No valid updates provided',
        message: 'Please provide valid status updates'
      });
    }

    allPropsSetParts.push('updated_at = NOW()');
    allPropsParams.push(propertyId);

    const updateQuery = `UPDATE all_properties SET ${allPropsSetParts.join(', ')} WHERE id = ?`;
    await query(updateQuery, allPropsParams);

    const updatedProperty = await query(
      'SELECT * FROM all_properties WHERE id = ?',
      [propertyId]
    );

    const processedProperty = {
      ...updatedProperty[0],
      price: parseFloat(updatedProperty[0].price),
      amenities: safeJsonParse(updatedProperty[0].amenities),
      facilities: safeJsonParse(updatedProperty[0].facilities),
      images: safeJsonParse(updatedProperty[0].images),
      rules: safeJsonParse(updatedProperty[0].rules, []),
      roommates: safeJsonParse(updatedProperty[0].roommates, [])
    };

    res.json({
      success: true,
      message: 'Property status updated successfully',
      property: processedProperty
    });

  } catch (error) {
    console.error('Error updating property status:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to update property status. Please try again.'
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
      'SELECT id, user_id, property_type FROM all_properties WHERE id = ?',
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

    await query('DELETE FROM all_properties WHERE id = ?', [propertyId]);

    res.json({
      success: true,
      message: 'Property deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting property:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to delete property. Please try again.'
    });
  }
});

module.exports = router;