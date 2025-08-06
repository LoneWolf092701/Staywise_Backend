const express = require('express');
const router = express.Router();
const { query, executeTransaction } = require('../config/db');
const { auth, requirePropertyOwner, requireAdmin, optionalAuth } = require('../middleware/auth');
const { uploadPropertyImages, processFileUpload, handleUploadError } = require('../middleware/upload');

/**
 * Safe JSON parsing function that handles both JSON and comma-separated string formats
 * This is needed because database may contain data in different formats
 * @param {string|null} value - The value to parse (JSON string or comma-separated string)
 * @returns {Array} Array of parsed values
 */
const safeJsonParse = (value) => {
  if (!value) return [];
  
  // If already an array, return it
  if (Array.isArray(value)) return value;
  
  // If it's a string, try to parse as JSON first
  if (typeof value === 'string') {
    // Try JSON parsing first
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      // If JSON parsing fails, treat as comma-separated string
      return value.split(',').map(item => item.trim()).filter(item => item.length > 0);
    }
  }
  
  return [];
};

/**
 * GET /api/properties/public
 * Get all approved and active properties (public endpoint that frontend expects)
 */
router.get('/public', optionalAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 12, 50);
    const offset = (page - 1) * limit;
    
    const sortBy = req.query.sort || 'created_at';
    const sortOrder = req.query.order === 'asc' ? 'ASC' : 'DESC';
    const allowedSortFields = ['created_at', 'price', 'views_count', 'property_type'];
    const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'created_at';

    let whereClause = 'WHERE ap.is_active = 1 AND ap.approval_status = ?';
    let queryParams = ['approved'];

    // Add filters
    if (req.query.property_type) {
      whereClause += ' AND ap.property_type = ?';
      queryParams.push(req.query.property_type);
    }
    
    if (req.query.unit_type) {
      whereClause += ' AND ap.unit_type = ?';
      queryParams.push(req.query.unit_type);
    }
    
    if (req.query.min_price) {
      whereClause += ' AND ap.price >= ?';
      queryParams.push(parseFloat(req.query.min_price));
    }
    
    if (req.query.max_price) {
      whereClause += ' AND ap.price <= ?';
      queryParams.push(parseFloat(req.query.max_price));
    }
    
    if (req.query.bedrooms) {
      whereClause += ' AND ap.bedrooms >= ?';
      queryParams.push(parseInt(req.query.bedrooms));
    }
    
    if (req.query.bathrooms) {
      whereClause += ' AND ap.bathrooms >= ?';
      queryParams.push(parseInt(req.query.bathrooms));
    }
    
    if (req.query.location) {
      whereClause += ' AND ap.address LIKE ?';
      queryParams.push(`%${req.query.location}%`);
    }

    // Date availability filters
    if (req.query.available_from) {
      whereClause += ' AND (ap.available_from IS NULL OR ap.available_from <= ?)';
      queryParams.push(req.query.available_from);
    }
    
    if (req.query.available_to) {
      whereClause += ' AND (ap.available_to IS NULL OR ap.available_to >= ?)';
      queryParams.push(req.query.available_to);
    }

    // Search functionality
    if (req.query.search) {
      whereClause += ' AND (ap.property_type LIKE ? OR ap.unit_type LIKE ? OR ap.address LIKE ? OR ap.description LIKE ?)';
      const searchTerm = `%${req.query.search}%`;
      queryParams.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    // Count total properties
    const countQuery = `
      SELECT COUNT(*) as total 
      FROM all_properties ap 
      ${whereClause}
    `;
    const countResult = await query(countQuery, queryParams);
    const totalProperties = countResult[0].total;

    // Get properties with owner info
    const propertiesQuery = `
      SELECT 
        ap.id, ap.property_type, ap.unit_type, ap.address, ap.price, 
        ap.amenities, ap.facilities, ap.images, ap.description, 
        ap.bedrooms, ap.bathrooms, ap.available_from, ap.available_to,
        ap.views_count, ap.created_at, ap.updated_at,
        u.username as owner_username,
        u.id as owner_id,
        COALESCE(AVG(ui.rating_score), 0) as average_rating,
        COUNT(CASE WHEN ui.interaction_type = 'rating' THEN 1 END) as total_ratings,
        COUNT(CASE WHEN ui.interaction_type = 'favorite' THEN 1 END) as total_favorites
      FROM all_properties ap
      INNER JOIN users u ON ap.user_id = u.id
      LEFT JOIN user_interactions ui ON ap.id = ui.property_id 
      ${whereClause}
      GROUP BY ap.id, u.username, u.id
      ORDER BY ap.${sortField} ${sortOrder}
      LIMIT ? OFFSET ?
    `;
    
    queryParams.push(limit, offset);
    const properties = await query(propertiesQuery, queryParams);

    // Process properties data using safe parsing
    const processedProperties = properties.map(property => ({
      ...property,
      price: parseFloat(property.price),
      amenities: safeJsonParse(property.amenities),
      facilities: safeJsonParse(property.facilities),
      images: safeJsonParse(property.images),
      average_rating: parseFloat(property.average_rating) || 0,
      total_ratings: parseInt(property.total_ratings) || 0,
      total_favorites: parseInt(property.total_favorites) || 0,
      is_favorited: false // Will be updated if user is authenticated
    }));

    // If user is authenticated, check favorites
    if (req.user) {
      const propertyIds = processedProperties.map(p => p.id);
      if (propertyIds.length > 0) {
        const favoritesQuery = `
          SELECT property_id 
          FROM user_interactions 
          WHERE user_id = ? AND property_id IN (${propertyIds.map(() => '?').join(',')}) AND interaction_type = 'favorite'
        `;
        const favorites = await query(favoritesQuery, [req.user.id, ...propertyIds]);
        const favoriteIds = favorites.map(f => f.property_id);
        
        processedProperties.forEach(property => {
          property.is_favorited = favoriteIds.includes(property.id);
        });
      }
    }

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
      filters_applied: {
        property_type: req.query.property_type || null,
        unit_type: req.query.unit_type || null,
        min_price: req.query.min_price || null,
        max_price: req.query.max_price || null,
        bedrooms: req.query.bedrooms || null,
        bathrooms: req.query.bathrooms || null,
        location: req.query.location || null,
        search: req.query.search || null
      }
    });

  } catch (error) {
    console.error('Error fetching properties:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch properties. Please try again.'
    });
  }
});

/**
 * GET /api/properties/search
 * Advanced property search with location-based filtering
 */
router.get('/search', optionalAuth, async (req, res) => {
  try {
    const {
      q: searchQuery,
      property_type,
      unit_type,
      min_price,
      max_price,
      bedrooms,
      bathrooms,
      amenities,
      facilities,
      location,
      lat,
      lng,
      radius = 10,
      available_from,
      available_to,
      sort = 'relevance',
      page = 1,
      limit = 12
    } = req.query;

    const pageNum = parseInt(page);
    const limitNum = Math.min(parseInt(limit), 50);
    const offset = (pageNum - 1) * limitNum;

    let whereClause = 'WHERE ap.is_active = 1 AND ap.approval_status = ?';
    let queryParams = ['approved'];
    let orderByClause = 'ORDER BY ap.created_at DESC';

    // Full-text search
    if (searchQuery) {
      whereClause += ' AND MATCH(ap.property_type, ap.unit_type, ap.address, ap.description) AGAINST (? IN NATURAL LANGUAGE MODE)';
      queryParams.push(searchQuery);
      if (sort === 'relevance') {
        orderByClause = 'ORDER BY MATCH(ap.property_type, ap.unit_type, ap.address, ap.description) AGAINST (? IN NATURAL LANGUAGE MODE) DESC';
      }
    }

    // Apply filters (same as regular search)
    if (property_type) {
      whereClause += ' AND ap.property_type = ?';
      queryParams.push(property_type);
    }
    
    if (unit_type) {
      whereClause += ' AND ap.unit_type = ?';
      queryParams.push(unit_type);
    }
    
    if (min_price) {
      whereClause += ' AND ap.price >= ?';
      queryParams.push(parseFloat(min_price));
    }
    
    if (max_price) {
      whereClause += ' AND ap.price <= ?';
      queryParams.push(parseFloat(max_price));
    }
    
    if (bedrooms) {
      whereClause += ' AND ap.bedrooms >= ?';
      queryParams.push(parseInt(bedrooms));
    }
    
    if (bathrooms) {
      whereClause += ' AND ap.bathrooms >= ?';
      queryParams.push(parseInt(bathrooms));
    }
    
    if (location) {
      whereClause += ' AND ap.address LIKE ?';
      queryParams.push(`%${location}%`);
    }

    // Amenities filter
    if (amenities) {
      const amenitiesList = amenities.split(',');
      amenitiesList.forEach(amenity => {
        whereClause += ' AND JSON_CONTAINS(ap.amenities, ?)';
        queryParams.push(`"${amenity.trim()}"`);
      });
    }

    // Facilities filter
    if (facilities) {
      const facilitiesList = facilities.split(',');
      facilitiesList.forEach(facility => {
        whereClause += ' AND JSON_CONTAINS(ap.facilities, ?)';
        queryParams.push(`"${facility.trim()}"`);
      });
    }

    // Date availability
    if (available_from) {
      whereClause += ' AND (ap.available_from IS NULL OR ap.available_from <= ?)';
      queryParams.push(available_from);
    }
    
    if (available_to) {
      whereClause += ' AND (ap.available_to IS NULL OR ap.available_to >= ?)';
      queryParams.push(available_to);
    }

    // Sort options
    if (sort === 'price_low') {
      orderByClause = 'ORDER BY ap.price ASC';
    } else if (sort === 'price_high') {
      orderByClause = 'ORDER BY ap.price DESC';
    } else if (sort === 'newest') {
      orderByClause = 'ORDER BY ap.created_at DESC';
    } else if (sort === 'popular') {
      orderByClause = 'ORDER BY ap.views_count DESC';
    }

    const searchQuerySql = `
      SELECT 
        ap.id, ap.property_type, ap.unit_type, ap.address, ap.price, 
        ap.amenities, ap.facilities, ap.images, ap.description, 
        ap.bedrooms, ap.bathrooms, ap.available_from, ap.available_to,
        ap.views_count, ap.created_at,
        u.username as owner_username,
        COALESCE(AVG(ui.rating_score), 0) as average_rating,
        COUNT(CASE WHEN ui.interaction_type = 'rating' THEN 1 END) as total_ratings
      FROM all_properties ap
      INNER JOIN users u ON ap.user_id = u.id
      LEFT JOIN user_interactions ui ON ap.id = ui.property_id
      ${whereClause}
      GROUP BY ap.id, u.username
      ${orderByClause}
      LIMIT ? OFFSET ?
    `;

    if (searchQuery && sort === 'relevance') {
      queryParams.push(searchQuery);
    }
    queryParams.push(limitNum, offset);

    const searchResults = await query(searchQuerySql, queryParams);

    const processedResults = searchResults.map(property => ({
      ...property,
      price: parseFloat(property.price),
      amenities: safeJsonParse(property.amenities),
      facilities: safeJsonParse(property.facilities),
      images: safeJsonParse(property.images),
      average_rating: parseFloat(property.average_rating) || 0,
      total_ratings: parseInt(property.total_ratings) || 0
    }));

    // Get total count for pagination
    const countQuery = `
      SELECT COUNT(DISTINCT ap.id) as total 
      FROM all_properties ap 
      INNER JOIN users u ON ap.user_id = u.id
      ${whereClause}
    `;
    let countParams = queryParams.slice(0, -2); // Remove limit and offset
    if (searchQuery && sort === 'relevance') {
      countParams.pop(); // Remove the extra search query param
    }
    
    const countResult = await query(countQuery, countParams);
    const totalResults = countResult[0].total;

    res.json({
      results: processedResults,
      search_metadata: {
        query: searchQuery || '',
        total_results: totalResults,
        page: pageNum,
        limit: limitNum,
        total_pages: Math.ceil(totalResults / limitNum)
      },
      filters_applied: {
        property_type, unit_type, min_price, max_price,
        bedrooms, bathrooms, amenities, facilities, location,
        available_from, available_to, sort
      }
    });

  } catch (error) {
    console.error('Error in property search:', error);
    res.status(500).json({
      error: 'Search error',
      message: 'Unable to perform search. Please try again.'
    });
  }
});

/**
 * GET /api/properties/public/:id
 * Get a specific property by ID (public endpoint that frontend expects)
 */
router.get('/public/:id', optionalAuth, async (req, res) => {
  const propertyId = req.params.id;

  if (!propertyId || isNaN(propertyId)) {
    return res.status(400).json({
      error: 'Invalid property ID',
      message: 'Property ID must be a valid number'
    });
  }

  try {
    const propertyQuery = `
      SELECT 
        ap.*, 
        u.username as owner_username,
        u.email as owner_email,
        up.phone as owner_phone,
        up.business_name as owner_business_name,
        COALESCE(AVG(CASE WHEN ui.interaction_type = 'rating' THEN ui.rating_score END), 0) as average_rating,
        COUNT(CASE WHEN ui.interaction_type = 'rating' THEN 1 END) as total_ratings,
        COUNT(CASE WHEN ui.interaction_type = 'favorite' THEN 1 END) as total_favorites
      FROM all_properties ap
      INNER JOIN users u ON ap.user_id = u.id
      LEFT JOIN user_profiles up ON u.id = up.user_id
      LEFT JOIN user_interactions ui ON ap.id = ui.property_id
      WHERE ap.id = ?
      GROUP BY ap.id, u.username, u.email, up.phone, up.business_name
    `;

    const properties = await query(propertyQuery, [propertyId]);

    if (properties.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'The requested property does not exist'
      });
    }

    const property = properties[0];

    // Check if property is accessible (active and approved, or user is owner/admin)
    const canAccess = property.is_active && property.approval_status === 'approved' ||
                     (req.user && (req.user.id === property.user_id || req.user.role === 'admin'));

    if (!canAccess) {
      return res.status(404).json({
        error: 'Property not available',
        message: 'This property is not currently available for viewing'
      });
    }

    // Get property ratings with comments
    const ratingsQuery = `
      SELECT 
        ui.rating_score, ui.rating_comment, ui.created_at as rated_at,
        u.username as reviewer_username
      FROM user_interactions ui
      INNER JOIN users u ON ui.user_id = u.id
      WHERE ui.property_id = ? AND ui.interaction_type = 'rating' AND ui.rating_score IS NOT NULL
      ORDER BY ui.created_at DESC
      LIMIT 10
    `;
    const ratings = await query(ratingsQuery, [propertyId]);

    // Check if current user has favorited this property
    let isFavorited = false;
    let userRating = null;

    if (req.user) {
      const favoriteCheck = await query(
        'SELECT id FROM user_interactions WHERE user_id = ? AND property_id = ? AND interaction_type = ?',
        [req.user.id, propertyId, 'favorite']
      );
      isFavorited = favoriteCheck.length > 0;

      const userRatingCheck = await query(
        'SELECT rating_score, rating_comment FROM user_interactions WHERE user_id = ? AND property_id = ? AND interaction_type = ?',
        [req.user.id, propertyId, 'rating']
      );
      if (userRatingCheck.length > 0) {
        userRating = userRatingCheck[0];
      }
    }

    // Process property data using safe parsing
    const processedProperty = {
      ...property,
      price: parseFloat(property.price),
      amenities: safeJsonParse(property.amenities),
      facilities: safeJsonParse(property.facilities),
      images: safeJsonParse(property.images),
      average_rating: parseFloat(property.average_rating) || 0,
      total_ratings: parseInt(property.total_ratings) || 0,
      total_favorites: parseInt(property.total_favorites) || 0,
      is_favorited: isFavorited,
      user_rating: userRating,
      ratings: ratings,
      owner_info: {
        username: property.owner_username,
        email: req.user && (req.user.id === property.user_id || req.user.role === 'admin') ? property.owner_email : null,
        phone: req.user && (req.user.id === property.user_id || req.user.role === 'admin') ? property.owner_phone : null,
        business_name: property.owner_business_name
      }
    };

    // Remove sensitive owner info from response
    delete processedProperty.owner_username;
    delete processedProperty.owner_email;
    delete processedProperty.owner_phone;
    delete processedProperty.owner_business_name;

    res.json(processedProperty);

  } catch (error) {
    console.error('Error fetching public property:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch property details. Please try again.'
    });
  }
});

/**
 * GET /api/properties/:id
 * Get a specific property by ID (legacy endpoint for backward compatibility)
 */
router.get('/:id', optionalAuth, async (req, res) => {
  const propertyId = req.params.id;

  if (!propertyId || isNaN(propertyId)) {
    return res.status(400).json({
      error: 'Invalid property ID',
      message: 'Property ID must be a valid number'
    });
  }

  try {
    const propertyQuery = `
      SELECT 
        ap.*, 
        u.username as owner_username,
        u.email as owner_email,
        up.phone as owner_phone,
        up.business_name as owner_business_name,
        COALESCE(AVG(CASE WHEN ui.interaction_type = 'rating' THEN ui.rating_score END), 0) as average_rating,
        COUNT(CASE WHEN ui.interaction_type = 'rating' THEN 1 END) as total_ratings,
        COUNT(CASE WHEN ui.interaction_type = 'favorite' THEN 1 END) as total_favorites
      FROM all_properties ap
      INNER JOIN users u ON ap.user_id = u.id
      LEFT JOIN user_profiles up ON u.id = up.user_id
      LEFT JOIN user_interactions ui ON ap.id = ui.property_id
      WHERE ap.id = ?
      GROUP BY ap.id, u.username, u.email, up.phone, up.business_name
    `;

    const properties = await query(propertyQuery, [propertyId]);

    if (properties.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'The requested property does not exist'
      });
    }

    const property = properties[0];

    // Check if property is accessible (active and approved, or user is owner/admin)
    const canAccess = property.is_active && property.approval_status === 'approved' ||
                     (req.user && (req.user.id === property.user_id || req.user.role === 'admin'));

    if (!canAccess) {
      return res.status(404).json({
        error: 'Property not available',
        message: 'This property is not currently available for viewing'
      });
    }

    // Get property ratings with comments
    const ratingsQuery = `
      SELECT 
        ui.rating_score, ui.rating_comment, ui.created_at as rated_at,
        u.username as reviewer_username
      FROM user_interactions ui
      INNER JOIN users u ON ui.user_id = u.id
      WHERE ui.property_id = ? AND ui.interaction_type = 'rating' AND ui.rating_score IS NOT NULL
      ORDER BY ui.created_at DESC
      LIMIT 10
    `;
    const ratings = await query(ratingsQuery, [propertyId]);

    // Check if current user has favorited this property
    let isFavorited = false;
    let userRating = null;

    if (req.user) {
      const favoriteCheck = await query(
        'SELECT id FROM user_interactions WHERE user_id = ? AND property_id = ? AND interaction_type = ?',
        [req.user.id, propertyId, 'favorite']
      );
      isFavorited = favoriteCheck.length > 0;

      const userRatingCheck = await query(
        'SELECT rating_score, rating_comment FROM user_interactions WHERE user_id = ? AND property_id = ? AND interaction_type = ?',
        [req.user.id, propertyId, 'rating']
      );
      if (userRatingCheck.length > 0) {
        userRating = userRatingCheck[0];
      }
    }

    // Process property data using safe parsing
    const processedProperty = {
      ...property,
      price: parseFloat(property.price),
      amenities: safeJsonParse(property.amenities),
      facilities: safeJsonParse(property.facilities),
      images: safeJsonParse(property.images),
      average_rating: parseFloat(property.average_rating) || 0,
      total_ratings: parseInt(property.total_ratings) || 0,
      total_favorites: parseInt(property.total_favorites) || 0,
      is_favorited: isFavorited,
      user_rating: userRating,
      ratings: ratings,
      owner_info: {
        username: property.owner_username,
        email: req.user && (req.user.id === property.user_id || req.user.role === 'admin') ? property.owner_email : null,
        phone: req.user && (req.user.id === property.user_id || req.user.role === 'admin') ? property.owner_phone : null,
        business_name: property.owner_business_name
      }
    };

    // Remove sensitive owner info from response
    delete processedProperty.owner_username;
    delete processedProperty.owner_email;
    delete processedProperty.owner_phone;
    delete processedProperty.owner_business_name;

    res.json(processedProperty);

  } catch (error) {
    console.error('Error fetching property:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch property details. Please try again.'
    });
  }
});

/**
 * POST /api/properties
 * Create a new property (property owners only)
 */
router.post('/', auth, requirePropertyOwner, uploadPropertyImages, processFileUpload, async (req, res) => {
  const userId = req.user.id;
  const propertyData = req.body;

  // Validate required fields
  const requiredFields = ['property_type', 'unit_type', 'address', 'price'];
  const missingFields = requiredFields.filter(field => !propertyData[field]);

  if (missingFields.length > 0) {
    return res.status(400).json({
      error: 'Missing required fields',
      message: `The following fields are required: ${missingFields.join(', ')}`,
      missing_fields: missingFields
    });
  }

  // Validate price
  const price = parseFloat(propertyData.price);
  if (isNaN(price) || price <= 0) {
    return res.status(400).json({
      error: 'Invalid price',
      message: 'Price must be a positive number'
    });
  }

  // Validate bedrooms and bathrooms
  const bedrooms = parseInt(propertyData.bedrooms) || 0;
  const bathrooms = parseInt(propertyData.bathrooms) || 0;

  if (bedrooms < 0 || bathrooms < 0) {
    return res.status(400).json({
      error: 'Invalid room counts',
      message: 'Bedrooms and bathrooms must be non-negative numbers'
    });
  }

  try {
    // Process uploaded images
    let images = [];
    if (req.uploadedFiles && req.uploadedFiles.propertyImages) {
      images = req.uploadedFiles.propertyImages.map(file => ({
        url: file.url,
        filename: file.filename,
        size: file.size
      }));
    }

    // Process amenities and facilities
    let amenities = [];
    let facilities = [];

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

    // Insert property
    const insertQuery = `
      INSERT INTO all_properties (
        user_id, property_type, unit_type, address, price, amenities, facilities, 
        images, description, bedrooms, bathrooms, available_from, available_to,
        is_active, approval_status, views_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', 0, NOW(), NOW())
    `;

    const result = await query(insertQuery, [
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
    ]);

    const newPropertyId = result.insertId;

    // Fetch and return the created property
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

/**
 * PUT /api/properties/:id
 * Update an existing property (owner or admin only)
 */
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
    // Check if property exists and user has permission
    const existingProperty = await query(
      'SELECT id, user_id, approval_status FROM all_properties WHERE id = ?',
      [propertyId]
    );

    if (existingProperty.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'The specified property does not exist'
      });
    }

    const property = existingProperty[0];

    // Check permissions
    if (userRole !== 'admin' && property.user_id !== userId) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You can only update properties you own'
      });
    }

    // Build update query dynamically
    const updateFields = {};
    const allowedFields = [
      'property_type', 'unit_type', 'address', 'price', 'amenities', 
      'facilities', 'description', 'bedrooms', 'bathrooms', 
      'available_from', 'available_to'
    ];

    // Admin-only fields
    if (userRole === 'admin') {
      allowedFields.push('is_active', 'approval_status');
    }

    allowedFields.forEach(field => {
      if (updateData[field] !== undefined) {
        if (field === 'price') {
          const price = parseFloat(updateData[field]);
          if (isNaN(price) || price <= 0) {
            return res.status(400).json({
              error: 'Invalid price',
              message: 'Price must be a positive number'
            });
          }
          updateFields[field] = price;
        } else if (field === 'bedrooms' || field === 'bathrooms') {
          const count = parseInt(updateData[field]);
          if (isNaN(count) || count < 0) {
            return res.status(400).json({
              error: `Invalid ${field}`,
              message: `${field} must be a non-negative number`
            });
          }
          updateFields[field] = count;
        } else if (field === 'amenities' || field === 'facilities') {
          let items = updateData[field];
          if (typeof items === 'string') {
            items = items.split(',').map(item => item.trim());
          }
          updateFields[field] = JSON.stringify(items || []);
        } else {
          updateFields[field] = updateData[field];
        }
      }
    });

    if (Object.keys(updateFields).length === 0) {
      return res.status(400).json({
        error: 'No valid fields to update',
        message: 'Please provide at least one field to update'
      });
    }

    // If property owner is updating, reset approval status to pending (except admin)
    if (userRole !== 'admin' && property.approval_status === 'approved') {
      updateFields.approval_status = 'pending';
    }

    // Build and execute update query
    const updateKeys = Object.keys(updateFields);
    const updateValues = Object.values(updateFields);
    const setClause = updateKeys.map(key => `${key} = ?`).join(', ');

    const updateQuery = `
      UPDATE all_properties 
      SET ${setClause}, updated_at = NOW() 
      WHERE id = ?
    `;

    await query(updateQuery, [...updateValues, propertyId]);

    // Fetch and return updated property
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
      property: processedProperty,
      approval_status: processedProperty.approval_status
    });

  } catch (error) {
    console.error('Error updating property:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to update property. Please try again.'
    });
  }
});

/**
 * DELETE /api/properties/:id
 * Delete/deactivate a property (owner or admin only)
 */
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
    // Check if property exists and user has permission
    const existingProperty = await query(
      'SELECT id, user_id, property_type, address FROM all_properties WHERE id = ?',
      [propertyId]
    );

    if (existingProperty.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'The specified property does not exist'
      });
    }

    const property = existingProperty[0];

    if (userRole !== 'admin' && property.user_id !== userId) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You can only delete properties you own'
      });
    }

    // Soft delete by setting is_active to false
    await query(
      'UPDATE all_properties SET is_active = 0, updated_at = NOW() WHERE id = ?',
      [propertyId]
    );

    res.json({
      message: 'Property deactivated successfully',
      property_id: parseInt(propertyId),
      property_info: {
        type: property.property_type,
        address: property.address
      }
    });

  } catch (error) {
    console.error('Error deleting property:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to delete property. Please try again.'
    });
  }
});

/**
 * GET /api/properties/details/:id
 * Get property details for editing (property owners and admins)
 */
router.get('/details/:id', auth, async (req, res) => {
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
        ap.*,
        u.username as owner_username
      FROM all_properties ap
      INNER JOIN users u ON ap.user_id = u.id
      WHERE ap.id = ?
    `;

    const properties = await query(propertyQuery, [propertyId]);

    if (properties.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'The requested property does not exist'
      });
    }

    const property = properties[0];

    // Check permissions - only owner or admin can access property details
    if (userRole !== 'admin' && property.user_id !== userId) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You can only view details of properties you own'
      });
    }

    // Process property data using safe parsing
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

/**
 * GET /api/properties/owner/mine
 * Get properties owned by the current user (property owners only)
 */
router.get('/owner/mine', auth, requirePropertyOwner, async (req, res) => {
  const userId = req.user.id;
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const offset = (page - 1) * limit;
  const status = req.query.status; // 'all', 'active', 'inactive', 'pending', 'approved', 'rejected'

  try {
    let whereClause = 'WHERE user_id = ?';
    let queryParams = [userId];

    if (status === 'active') {
      whereClause += ' AND is_active = 1';
    } else if (status === 'inactive') {
      whereClause += ' AND is_active = 0';
    } else if (['pending', 'approved', 'rejected'].includes(status)) {
      whereClause += ' AND approval_status = ?';
      queryParams.push(status);
    }

    // Count total properties
    const countQuery = `SELECT COUNT(*) as total FROM all_properties ${whereClause}`;
    const countResult = await query(countQuery, queryParams);
    const totalProperties = countResult[0].total;

    // Get properties with statistics
    const propertiesQuery = `
      SELECT 
        ap.*,
        COALESCE(AVG(CASE WHEN ui.interaction_type = 'rating' THEN ui.rating_score END), 0) as average_rating,
        COUNT(CASE WHEN ui.interaction_type = 'rating' THEN 1 END) as total_ratings,
        COUNT(CASE WHEN ui.interaction_type = 'favorite' THEN 1 END) as total_favorites,
        COUNT(CASE WHEN ui.interaction_type = 'complaint' THEN 1 END) as total_complaints
      FROM all_properties ap
      LEFT JOIN user_interactions ui ON ap.id = ui.property_id
      ${whereClause}
      GROUP BY ap.id
      ORDER BY ap.created_at DESC
      LIMIT ? OFFSET ?
    `;

    queryParams.push(limit, offset);
    const properties = await query(propertiesQuery, queryParams);

    const processedProperties = properties.map(property => ({
      ...property,
      price: parseFloat(property.price),
      amenities: safeJsonParse(property.amenities),
      facilities: safeJsonParse(property.facilities),
      images: safeJsonParse(property.images),
      average_rating: parseFloat(property.average_rating) || 0,
      total_ratings: parseInt(property.total_ratings) || 0,
      total_favorites: parseInt(property.total_favorites) || 0,
      total_complaints: parseInt(property.total_complaints) || 0
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
      summary: {
        total_properties: totalProperties,
        filter_applied: status || 'all'
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

// Error handling middleware
router.use(handleUploadError);

module.exports = router;