const express = require('express');
const router = express.Router();
const { query, executeTransaction } = require('../config/db');
const { auth, requirePropertyOwnership } = require('../middleware/auth');

const safeJsonParse = (str) => {
  try {
    return typeof str === 'string' ? JSON.parse(str) : str;
  } catch (error) {
    console.warn('Error parsing JSON:', error);
    return str || [];
  }
};

const validatePropertyData = (propertyData) => {
  const errors = [];

  if (!propertyData.property_type || typeof propertyData.property_type !== 'string') {
    errors.push('Property type is required');
  }

  if (!propertyData.unit_type || typeof propertyData.unit_type !== 'string') {
    errors.push('Unit type is required');
  }

  if (!propertyData.address || typeof propertyData.address !== 'string') {
    errors.push('Address is required');
  }

  if (!propertyData.description || typeof propertyData.description !== 'string') {
    errors.push('Description is required');
  }

  if (!propertyData.price || isNaN(parseFloat(propertyData.price)) || parseFloat(propertyData.price) <= 0) {
    errors.push('Price must be a positive number');
  }

  if (!propertyData.availableFrom) {
    errors.push('Available from date is required');
  }

  if (!propertyData.contractPolicy || typeof propertyData.contractPolicy !== 'string') {
    errors.push('Contract policy is required');
  }

  if (!propertyData.amenities || typeof propertyData.amenities !== 'object') {
    errors.push('Amenities information is required');
  }

  if (!propertyData.facilities || typeof propertyData.facilities !== 'object') {
    errors.push('Facilities information is required');
  } else {
    const facilities = propertyData.facilities;
    const bathroomCount = parseInt(facilities.Bathroom || facilities.Bathrooms || 0);
    const bedroomCount = parseInt(facilities.Bedroom || facilities.Bedrooms || 0);
    
    if (bathroomCount < 1) {
      errors.push('At least 1 bathroom is required');
    }
    if (bedroomCount < 0) {
      errors.push('Bedrooms cannot be negative');
    }
  }

  return errors;
};

const formatDateForMySQL = (dateStr) => {
  if (!dateStr) return null;
  try {
    const date = new Date(dateStr);
    return date.toISOString().split('T')[0];
  } catch (error) {
    console.warn('Date formatting error:', error);
    return null;
  }
};

router.get('/public', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = (page - 1) * limit;
    
    const search = req.query.search || '';
    const property_type = req.query.property_type || '';
    const min_price = req.query.min_price ? parseFloat(req.query.min_price) : null;
    const max_price = req.query.max_price ? parseFloat(req.query.max_price) : null;
    const location = req.query.location || '';
    const sort_by = req.query.sort_by || 'created_at';
    const sort_order = req.query.sort_order === 'asc' ? 'ASC' : 'DESC';

    let whereConditions = ['approval_status = ?', 'is_active = ?'];
    let queryParams = ['approved', 1];

    if (search) {
      whereConditions.push('(property_type LIKE ? OR unit_type LIKE ? OR address LIKE ? OR description LIKE ?)');
      const searchPattern = `%${search}%`;
      queryParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
    }

    if (property_type) {
      whereConditions.push('property_type = ?');
      queryParams.push(property_type);
    }

    if (min_price !== null) {
      whereConditions.push('price >= ?');
      queryParams.push(min_price);
    }

    if (max_price !== null) {
      whereConditions.push('price <= ?');
      queryParams.push(max_price);
    }

    if (location) {
      whereConditions.push('address LIKE ?');
      queryParams.push(`%${location}%`);
    }

    const whereClause = whereConditions.join(' AND ');

    const validSortColumns = ['created_at', 'price', 'views_count', 'property_type'];
    const sortColumn = validSortColumns.includes(sort_by) ? sort_by : 'created_at';

    const countQuery = `SELECT COUNT(*) as total FROM all_properties WHERE ${whereClause}`;
    const countResult = await query(countQuery, queryParams);
    const totalProperties = countResult[0].total;

    const propertiesQuery = `
      SELECT * FROM all_properties 
      WHERE ${whereClause}
      ORDER BY ${sortColumn} ${sort_order}
      LIMIT ? OFFSET ?
    `;

    const properties = await query(propertiesQuery, [...queryParams, limit, offset]);

    const processedProperties = properties.map(property => ({
      ...property,
      price: parseFloat(property.price),
      amenities: safeJsonParse(property.amenities),
      facilities: safeJsonParse(property.facilities),
      images: safeJsonParse(property.images)
    }));

    res.json({
      properties: processedProperties,
      pagination: {
        page: page,
        limit: limit,
        total: totalProperties,
        totalPages: Math.ceil(totalProperties / limit),
        hasNext: page < Math.ceil(totalProperties / limit),
        hasPrevious: page > 1
      },
      filters: {
        search,
        property_type,
        min_price,
        max_price,
        location,
        sort_by: sortColumn,
        sort_order: sort_order.toLowerCase()
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
    const properties = await query(
      'SELECT * FROM all_properties WHERE id = ? AND approval_status = ? AND is_active = ?',
      [propertyId, 'approved', 1]
    );

    if (properties.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'The requested property could not be found or is not available'
      });
    }

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

router.get('/owner/mine', auth, async (req, res) => {
  const userId = req.user.id;
  
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = (page - 1) * limit;
    
    const search = req.query.search || '';
    const status = req.query.status || '';
    const approval_status = req.query.approval_status || '';
    const sort_by = req.query.sort_by || 'created_at';
    const sort_order = req.query.sort_order === 'asc' ? 'ASC' : 'DESC';

    let whereConditions = ['user_id = ?'];
    let queryParams = [userId];

    if (search) {
      whereConditions.push('(property_type LIKE ? OR unit_type LIKE ? OR address LIKE ? OR description LIKE ?)');
      const searchPattern = `%${search}%`;
      queryParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
    }

    if (status) {
      if (status === 'active') {
        whereConditions.push('is_active = ?');
        queryParams.push(1);
      } else if (status === 'inactive') {
        whereConditions.push('is_active = ?');
        queryParams.push(0);
      }
    }

    if (approval_status) {
      whereConditions.push('approval_status = ?');
      queryParams.push(approval_status);
    }

    const whereClause = whereConditions.join(' AND ');

    const validSortColumns = ['created_at', 'updated_at', 'price', 'views_count', 'property_type', 'approval_status'];
    const sortColumn = validSortColumns.includes(sort_by) ? sort_by : 'created_at';

    const countQuery = `SELECT COUNT(*) as total FROM all_properties WHERE ${whereClause}`;
    const countResult = await query(countQuery, queryParams);
    const totalProperties = countResult[0].total;

    const propertiesQuery = `
      SELECT * FROM all_properties 
      WHERE ${whereClause}
      ORDER BY ${sortColumn} ${sort_order}
      LIMIT ? OFFSET ?
    `;

    const properties = await query(propertiesQuery, [...queryParams, limit, offset]);

    const processedProperties = properties.map(property => ({
      ...property,
      price: parseFloat(property.price),
      amenities: safeJsonParse(property.amenities),
      facilities: safeJsonParse(property.facilities),
      images: safeJsonParse(property.images)
    }));

    const statsQuery = `
      SELECT 
        COUNT(*) as total_count,
        SUM(CASE WHEN approval_status = 'approved' THEN 1 ELSE 0 END) as approved_count,
        SUM(CASE WHEN approval_status = 'pending' THEN 1 ELSE 0 END) as pending_count,
        SUM(CASE WHEN approval_status = 'rejected' THEN 1 ELSE 0 END) as rejected_count,
        SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active_count,
        SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) as inactive_count,
        SUM(COALESCE(views_count, 0)) as total_views
      FROM all_properties 
      WHERE user_id = ?
    `;

    const statsResult = await query(statsQuery, [userId]);
    const stats = statsResult[0];

    res.json({
      properties: processedProperties,
      pagination: {
        page: page,
        limit: limit,
        total: totalProperties,
        totalPages: Math.ceil(totalProperties / limit),
        hasNext: page < Math.ceil(totalProperties / limit),
        hasPrevious: page > 1
      },
      stats: {
        total: parseInt(stats.total_count),
        approved: parseInt(stats.approved_count),
        pending: parseInt(stats.pending_count),
        rejected: parseInt(stats.rejected_count),
        active: parseInt(stats.active_count),
        inactive: parseInt(stats.inactive_count),
        total_views: parseInt(stats.total_views)
      },
      filters: {
        search,
        status,
        approval_status,
        sort_by: sortColumn,
        sort_order: sort_order.toLowerCase()
      }
    });

  } catch (error) {
    console.error('Error fetching owner properties:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch your properties. Please try again.'
    });
  }
});

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

  const validationErrors = validatePropertyData(propertyData);
  if (validationErrors.length > 0) {
    return res.status(400).json({
      error: 'Validation failed',
      message: validationErrors.join(', ')
    });
  }

  try {
    const price = parseFloat(propertyData.price);
    const bedrooms = propertyData.facilities?.Bedroom || propertyData.facilities?.Bedrooms ? 
      parseInt(propertyData.facilities.Bedroom || propertyData.facilities.Bedrooms) : 0;
    const bathrooms = propertyData.facilities?.Bathroom || propertyData.facilities?.Bathrooms ? 
      parseInt(propertyData.facilities.Bathroom || propertyData.facilities.Bathrooms) : 0;

    const normalizedFacilities = { ...propertyData.facilities };
    if (normalizedFacilities.Bedrooms !== undefined) {
      normalizedFacilities.Bedroom = normalizedFacilities.Bedrooms;
      delete normalizedFacilities.Bedrooms;
    }
    if (normalizedFacilities.Bathrooms !== undefined) {
      normalizedFacilities.Bathroom = normalizedFacilities.Bathrooms;
      delete normalizedFacilities.Bathrooms;
    }

    const availableFromDate = formatDateForMySQL(propertyData.availableFrom);
    const availableToDate = formatDateForMySQL(propertyData.availableTo);

    const transactionQueries = [
      {
        sql: `INSERT INTO all_properties (
          user_id, property_type, unit_type, address, price, amenities, facilities, 
          images, description, bedrooms, bathrooms, available_from, available_to, 
          is_active, approval_status, views_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', 0)`,
        params: [
          userId,
          propertyData.property_type,
          propertyData.unit_type,
          propertyData.address,
          price,
          JSON.stringify(propertyData.amenities),
          JSON.stringify(normalizedFacilities),
          JSON.stringify(propertyData.images || []),
          propertyData.description,
          bedrooms,
          bathrooms,
          availableFromDate,
          availableToDate
        ]
      },
      {
        sql: `INSERT INTO property_details (
          user_id, property_type, unit_type, amenities, facilities, other_facility,
          roommates, rules, contract_policy, address, available_from, available_to,
          price_range, bills_inclusive, approval_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        params: [
          userId,
          propertyData.property_type,
          propertyData.unit_type,
          JSON.stringify(propertyData.amenities),
          JSON.stringify(normalizedFacilities),
          propertyData.otherFacility || propertyData.other_facility || '',
          JSON.stringify(propertyData.roommates || []),
          JSON.stringify(propertyData.rules || []),
          propertyData.contractPolicy,
          propertyData.address,
          availableFromDate,
          availableToDate,
          JSON.stringify({ min: price, max: price }),
          JSON.stringify(propertyData.billsInclusive || [])
        ]
      }
    ];

    const results = await executeTransaction(transactionQueries);
    const propertyId = results[0].insertId;

    res.status(201).json({
      message: 'Property created successfully',
      property_id: propertyId,
      approval_status: 'pending'
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

  if (!updateData || typeof updateData !== 'object') {
    return res.status(400).json({
      error: 'Invalid data',
      message: 'Update data is required'
    });
  }

  try {
    let whereClause = 'id = ?';
    let queryParams = [propertyId];

    if (userRole !== 'admin') {
      whereClause += ' AND user_id = ?';
      queryParams.push(userId);
    }

    const existingProperty = await query(
      `SELECT * FROM all_properties WHERE ${whereClause}`,
      queryParams
    );

    if (existingProperty.length === 0) {
      return res.status(404).json({
        error: 'Property not found or access denied'
      });
    }

    const normalizedFacilities = { ...updateData.facilities };
    if (normalizedFacilities?.Bedrooms !== undefined) {
      normalizedFacilities.Bedroom = normalizedFacilities.Bedrooms;
      delete normalizedFacilities.Bedrooms;
    }
    if (normalizedFacilities?.Bathrooms !== undefined) {
      normalizedFacilities.Bathroom = normalizedFacilities.Bathrooms;
      delete normalizedFacilities.Bathrooms;
    }

    const bedrooms = normalizedFacilities?.Bedroom ? parseInt(normalizedFacilities.Bedroom) : 0;
    const bathrooms = normalizedFacilities?.Bathroom ? parseInt(normalizedFacilities.Bathroom) : 0;

    const availableFromDate = formatDateForMySQL(updateData.available_from || updateData.availableFrom);
    const availableToDate = formatDateForMySQL(updateData.available_to || updateData.availableTo);

    const transactionQueries = [
      {
        sql: `UPDATE all_properties 
        SET property_type = ?, unit_type = ?, address = ?, price = ?, 
            amenities = ?, facilities = ?, images = ?, description = ?, 
            bedrooms = ?, bathrooms = ?, available_from = ?, available_to = ?
        WHERE id = ? AND user_id = ?`,
        params: [
          updateData.property_type || updateData.propertyType,
          updateData.unit_type || updateData.unitType,
          updateData.address,
          parseFloat(updateData.price),
          JSON.stringify(updateData.amenities || {}),
          JSON.stringify(normalizedFacilities || {}),
          JSON.stringify(updateData.images || []),
          updateData.description,
          bedrooms,
          bathrooms,
          availableFromDate,
          availableToDate,
          propertyId,
          userId
        ]
      },
      {
        sql: `UPDATE property_details 
        SET property_type = ?, unit_type = ?, amenities = ?, facilities = ?, 
            other_facility = ?, rules = ?, contract_policy = ?, address = ?, 
            available_from = ?, available_to = ?, roommates = ?, 
            bills_inclusive = ?
        WHERE user_id = ?`,
        params: [
          updateData.property_type || updateData.propertyType,
          updateData.unit_type || updateData.unitType,
          JSON.stringify(updateData.amenities || {}),
          JSON.stringify(normalizedFacilities || {}),
          updateData.otherFacility || updateData.other_facility || '',
          JSON.stringify(updateData.rules || []),
          updateData.contract_policy || updateData.contractPolicy,
          updateData.address,
          availableFromDate,
          availableToDate,
          JSON.stringify(updateData.roommates || []),
          JSON.stringify(updateData.bills_inclusive || updateData.billsInclusive || []),
          userId
        ]
      }
    ];

    await executeTransaction(transactionQueries);

    res.json({
      message: 'Property updated successfully',
      property_id: propertyId
    });

  } catch (error) {
    console.error('Error updating property:', error);
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
    let whereClause = 'id = ?';
    let queryParams = [propertyId];

    if (userRole !== 'admin') {
      whereClause += ' AND user_id = ?';
      queryParams.push(userId);
    }

    const existingProperty = await query(
      `SELECT id, user_id FROM all_properties WHERE ${whereClause}`,
      queryParams
    );

    if (existingProperty.length === 0) {
      return res.status(404).json({
        error: 'Property not found or access denied'
      });
    }

    const property = existingProperty[0];

    const transactionQueries = [
      {
        sql: 'DELETE FROM property_details WHERE user_id = ?',
        params: [property.user_id]
      },
      {
        sql: `DELETE FROM all_properties WHERE ${whereClause}`,
        params: queryParams
      }
    ];

    await executeTransaction(transactionQueries);

    res.json({
      message: 'Property deleted successfully',
      property_id: propertyId
    });

  } catch (error) {
    console.error('Error deleting property:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to delete property. Please try again.'
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
        allPropsParams.push(updates.approval_status);
      }
    }

    if (allPropsSetParts.length === 0) {
      return res.status(400).json({
        error: 'No valid updates provided',
        message: 'Please provide valid fields to update'
      });
    }

    allPropsParams.push(propertyId);

    await query(
      `UPDATE all_properties SET ${allPropsSetParts.join(', ')} WHERE id = ?`,
      allPropsParams
    );

    res.json({
      message: 'Property status updated successfully',
      property_id: parseInt(propertyId),
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

router.post('/:id/details', auth, requirePropertyOwnership, async (req, res) => {
  const propertyId = req.params.id;
  const userId = req.user.id;
  const detailsData = req.body;

  try {
    const transactionQueries = [
      {
        sql: 'DELETE FROM property_details WHERE user_id = ? AND property_id = ?',
        params: [userId, propertyId]
      }
    ];

    if (detailsData && Object.keys(detailsData).length > 0) {
      transactionQueries.push({
        sql: `INSERT INTO property_details (
          user_id, property_id, details_data
        ) VALUES (?, ?, ?)`,
        params: [
          userId,
          propertyId,
          JSON.stringify(detailsData)
        ]
      });
    }

    await executeTransaction(transactionQueries);

    res.json({
      message: 'Property details updated successfully',
      property_id: propertyId
    });

  } catch (error) {
    console.error('Error updating property details:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to update property details. Please try again.'
    });
  }
});

module.exports = router;