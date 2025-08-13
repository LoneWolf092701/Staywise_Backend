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

    await executeTransaction(async (connection) => {
      const propertyQuery = `
        INSERT INTO all_properties (
          user_id, property_type, unit_type, address, price, amenities, facilities, 
          images, description, bedrooms, bathrooms, available_from, available_to, 
          is_active, approval_status, views_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', 0, NOW(), NOW())
      `;

      const propertyResult = await connection.execute(propertyQuery, [
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
        propertyData.availableFrom,
        propertyData.availableTo || null
      ]);

      const propertyId = propertyResult[0].insertId;

      const detailsQuery = `
        INSERT INTO property_details (
          user_id, property_type, unit_type, amenities, facilities,
          roommates, rules, contract_policy, address, available_from, available_to,
          price_range, bills_inclusive, approval_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW(), NOW())
      `;

      await connection.execute(detailsQuery, [
        userId,
        propertyData.property_type,
        propertyData.unit_type,
        JSON.stringify(propertyData.amenities),
        JSON.stringify(normalizedFacilities),
        JSON.stringify(propertyData.roommates || []),
        JSON.stringify(propertyData.rules || []),
        propertyData.contractPolicy,
        propertyData.address,
        propertyData.availableFrom,
        propertyData.availableTo || null,
        JSON.stringify({ min: price * 0.9, max: price * 1.1 }),
        JSON.stringify(propertyData.billsInclusive || [])
      ]);

      return propertyId;
    });

    res.status(201).json({
      message: 'Property created successfully',
      property: {
        property_type: propertyData.property_type,
        unit_type: propertyData.unit_type,
        address: propertyData.address,
        price: price,
        approval_status: 'pending'
      }
    });

  } catch (error) {
    console.error('Error creating property:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to create property. Please try again.'
    });
  }
});

router.get('/my-properties', auth, async (req, res) => {
  const userId = req.user.id;

  try {
    const properties = await query(
      `SELECT 
        ap.*, 
        pd.rules, 
        pd.contract_policy, 
        pd.roommates, 
        pd.bills_inclusive,
        pd.price_range
      FROM all_properties ap
      LEFT JOIN property_details pd ON ap.user_id = pd.user_id
      WHERE ap.user_id = ? 
      ORDER BY ap.created_at DESC`,
      [userId]
    );

    const formattedProperties = properties.map(property => ({
      ...property,
      amenities: safeJsonParse(property.amenities),
      facilities: safeJsonParse(property.facilities),
      images: safeJsonParse(property.images),
      rules: safeJsonParse(property.rules),
      roommates: safeJsonParse(property.roommates),
      bills_inclusive: safeJsonParse(property.bills_inclusive),
      price_range: safeJsonParse(property.price_range)
    }));

    res.json({
      properties: formattedProperties,
      total: formattedProperties.length
    });

  } catch (error) {
    console.error('Error fetching user properties:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch properties. Please try again.'
    });
  }
});

router.get('/public', async (req, res) => {
  const { 
    limit = 50, 
    offset = 0, 
    property_type, 
    unit_type, 
    min_price, 
    max_price,
    bedrooms,
    bathrooms,
    search,
    sort_by = 'created_at',
    sort_order = 'DESC'
  } = req.query;

  try {
    let whereConditions = ['ap.is_active = 1', 'ap.approval_status = ?'];
    let queryParams = ['approved'];

    if (property_type) {
      whereConditions.push('ap.property_type = ?');
      queryParams.push(property_type);
    }

    if (unit_type) {
      whereConditions.push('ap.unit_type = ?');
      queryParams.push(unit_type);
    }

    if (min_price) {
      whereConditions.push('ap.price >= ?');
      queryParams.push(parseFloat(min_price));
    }

    if (max_price) {
      whereConditions.push('ap.price <= ?');
      queryParams.push(parseFloat(max_price));
    }

    if (bedrooms) {
      whereConditions.push('ap.bedrooms >= ?');
      queryParams.push(parseInt(bedrooms));
    }

    if (bathrooms) {
      whereConditions.push('ap.bathrooms >= ?');
      queryParams.push(parseInt(bathrooms));
    }

    if (search) {
      whereConditions.push('(ap.address LIKE ? OR ap.description LIKE ? OR ap.property_type LIKE ?)');
      const searchPattern = `%${search}%`;
      queryParams.push(searchPattern, searchPattern, searchPattern);
    }

    const validSortColumns = ['created_at', 'price', 'views_count', 'property_type'];
    const validSortOrders = ['ASC', 'DESC'];
    
    const sortColumn = validSortColumns.includes(sort_by) ? sort_by : 'created_at';
    const sortOrder = validSortOrders.includes(sort_order.toUpperCase()) ? sort_order.toUpperCase() : 'DESC';

    const propertiesQuery = `
      SELECT 
        ap.*, 
        pd.rules, 
        pd.contract_policy, 
        pd.roommates, 
        pd.bills_inclusive,
        pd.price_range
      FROM all_properties ap
      LEFT JOIN property_details pd ON ap.user_id = pd.user_id
      WHERE ${whereConditions.join(' AND ')}
      ORDER BY ap.${sortColumn} ${sortOrder}
      LIMIT ? OFFSET ?
    `;

    queryParams.push(parseInt(limit), parseInt(offset));

    const properties = await query(propertiesQuery, queryParams);

    const countQuery = `
      SELECT COUNT(*) as total
      FROM all_properties ap
      WHERE ${whereConditions.join(' AND ')}
    `;

    const countResult = await query(countQuery, queryParams.slice(0, -2));
    const total = countResult[0].total;

    const formattedProperties = properties.map(property => ({
      ...property,
      amenities: safeJsonParse(property.amenities),
      facilities: safeJsonParse(property.facilities),
      images: safeJsonParse(property.images),
      rules: safeJsonParse(property.rules),
      roommates: safeJsonParse(property.roommates),
      bills_inclusive: safeJsonParse(property.bills_inclusive),
      price_range: safeJsonParse(property.price_range)
    }));

    res.json({
      properties: formattedProperties,
      total,
      limit: parseInt(limit),
      offset: parseInt(offset),
      hasMore: (parseInt(offset) + parseInt(limit)) < total
    });

  } catch (error) {
    console.error('Error fetching properties:', error);
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
      error: 'Invalid property ID'
    });
  }

  try {
    const properties = await query(
      `SELECT 
        ap.*, 
        pd.rules, 
        pd.contract_policy, 
        pd.roommates, 
        pd.bills_inclusive,
        pd.price_range,
        u.username,
        u.email,
        up.first_name,
        up.last_name,
        up.phone
      FROM all_properties ap
      LEFT JOIN property_details pd ON ap.user_id = pd.user_id
      LEFT JOIN users u ON ap.user_id = u.id
      LEFT JOIN user_profiles up ON u.id = up.user_id
      WHERE ap.id = ? AND ap.is_active = 1 AND ap.approval_status = 'approved'`,
      [propertyId]
    );

    if (properties.length === 0) {
      return res.status(404).json({
        error: 'Property not found'
      });
    }

    const property = properties[0];
    const formattedProperty = {
      ...property,
      amenities: safeJsonParse(property.amenities),
      facilities: safeJsonParse(property.facilities),
      images: safeJsonParse(property.images),
      rules: safeJsonParse(property.rules),
      roommates: safeJsonParse(property.roommates),
      bills_inclusive: safeJsonParse(property.bills_inclusive),
      price_range: safeJsonParse(property.price_range),
      owner_info: {
        first_name: property.first_name,
        last_name: property.last_name,
        email: property.email,
        phone: property.phone,
        username: property.username
      }
    };

    delete formattedProperty.first_name;
    delete formattedProperty.last_name;
    delete formattedProperty.email;
    delete formattedProperty.phone;
    delete formattedProperty.username;

    res.json(formattedProperty);

  } catch (error) {
    console.error('Error fetching property:', error);
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
      SELECT ap.*, 
        u.username as owner_name,
        u.email as owner_email,
        pd.rules, pd.roommates, pd.contract_policy, pd.bills_inclusive
      FROM all_properties ap
      LEFT JOIN users u ON ap.user_id = u.id
      LEFT JOIN property_details pd ON ap.user_id = pd.user_id
      WHERE ap.id = ?
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
      rules: safeJsonParse(property.rules),
      roommates: safeJsonParse(property.roommates),
      bills_inclusive: safeJsonParse(property.bills_inclusive)
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

router.put('/:id', auth, async (req, res) => {
  const propertyId = req.params.id;
  const userId = req.user.id;
  const updateData = req.body;

  if (!propertyId || isNaN(propertyId)) {
    return res.status(400).json({
      error: 'Invalid property ID'
    });
  }

  try {
    const existingProperty = await query(
      'SELECT id, user_id FROM all_properties WHERE id = ? AND user_id = ?',
      [propertyId, userId]
    );

    if (existingProperty.length === 0) {
      return res.status(404).json({
        error: 'Property not found or access denied'
      });
    }

    const normalizedFacilities = { ...updateData.facilities };
    if (normalizedFacilities && normalizedFacilities.Bedrooms !== undefined) {
      normalizedFacilities.Bedroom = normalizedFacilities.Bedrooms;
      delete normalizedFacilities.Bedrooms;
    }
    if (normalizedFacilities && normalizedFacilities.Bathrooms !== undefined) {
      normalizedFacilities.Bathroom = normalizedFacilities.Bathrooms;
      delete normalizedFacilities.Bathrooms;
    }

    const bedrooms = normalizedFacilities?.Bedroom ? parseInt(normalizedFacilities.Bedroom) : 0;
    const bathrooms = normalizedFacilities?.Bathroom ? parseInt(normalizedFacilities.Bathroom) : 0;

    await executeTransaction(async (connection) => {
      const updatePropertyQuery = `
        UPDATE all_properties 
        SET property_type = ?, unit_type = ?, address = ?, price = ?, 
            amenities = ?, facilities = ?, images = ?, description = ?, 
            bedrooms = ?, bathrooms = ?, available_from = ?, available_to = ?, 
            updated_at = NOW()
        WHERE id = ? AND user_id = ?
      `;

      await connection.execute(updatePropertyQuery, [
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
        updateData.available_from || updateData.availableFrom,
        updateData.available_to || updateData.availableTo,
        propertyId,
        userId
      ]);

      const updateDetailsQuery = `
        UPDATE property_details 
        SET property_type = ?, unit_type = ?, amenities = ?, facilities = ?, 
            rules = ?, contract_policy = ?, address = ?, 
            available_from = ?, available_to = ?, roommates = ?, 
            bills_inclusive = ?, updated_at = NOW()
        WHERE user_id = ?
      `;

      await connection.execute(updateDetailsQuery, [
        updateData.property_type || updateData.propertyType,
        updateData.unit_type || updateData.unitType,
        JSON.stringify(updateData.amenities || {}),
        JSON.stringify(normalizedFacilities || {}),
        JSON.stringify(updateData.rules || []),
        updateData.contract_policy || updateData.contractPolicy,
        updateData.address,
        updateData.available_from || updateData.availableFrom,
        updateData.available_to || updateData.availableTo,
        JSON.stringify(updateData.roommates || []),
        JSON.stringify(updateData.bills_inclusive || updateData.billsInclusive || []),
        userId
      ]);
    });

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

    await executeTransaction(async (connection) => {
      await connection.execute(
        'DELETE FROM property_details WHERE user_id = ?',
        [property.user_id]
      );
      
      await connection.execute(
        `DELETE FROM all_properties WHERE ${whereClause}`,
        queryParams
      );
    });

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

    allPropsSetParts.push('updated_at = NOW()');
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

module.exports = router;