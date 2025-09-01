const express = require('express');
const router = express.Router();
const { query, executeTransaction } = require('../config/db');
const { auth, requirePropertyOwner, requirePropertyOwnership, optionalAuth } = require('../middleware/auth');
const dayjs = require('dayjs');
const multer = require('multer');
const path = require('path');

const safeJsonParse = (value) => {
  if (!value) return [];
  
  // If already an array, return it
  if (Array.isArray(value)) return value;
  
  // If it's a string, try to parse as JSON first
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      
      // If parsed is an object (like {"Parking": 1, "Pool": 1}), extract keys
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return Object.keys(parsed).filter(key => parsed[key] > 0);
      }
      
      // If parsed is an array, return it
      if (Array.isArray(parsed)) {
        return parsed;
      }
      
      // If single value, wrap in array
      return [parsed];
    } catch (error) {
      // If JSON parsing fails, treat as comma-separated string
      return value.split(',').map(item => item.trim()).filter(item => item.length > 0);
    }
  }
  
  // If it's already an object, extract keys where value > 0
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.keys(value).filter(key => value[key] > 0);
  }
  
  return [];
};

const processPropertyData = (property) => {
  if (!property) return property;

  // Parse facilities properly to handle count extraction
  let parsedFacilities = {};
  if (property.facilities) {
    try {
      parsedFacilities = typeof property.facilities === 'string' 
        ? JSON.parse(property.facilities) 
        : property.facilities;
    } catch (e) {
      console.warn('Invalid facilities JSON:', property.facilities);
      parsedFacilities = {};
    }
  }

  // Normalize facility counts - handle both singular and plural forms
  const normalizedFacilities = {};
  Object.entries(parsedFacilities).forEach(([key, value]) => {
    const normalizedKey = key.toLowerCase();
    let count = 0;
    
    if (typeof value === 'object' && value !== null) {
      count = 1; // If it's an object, count as 1
    } else if (typeof value === 'number') {
      count = value;
    } else if (typeof value === 'string') {
      const numValue = parseInt(value);
      count = isNaN(numValue) ? (value ? 1 : 0) : numValue;
    } else {
      count = value ? 1 : 0;
    }

    // Normalize plural/singular forms
    if (normalizedKey.includes('bedroom')) {
      normalizedFacilities['bedroom'] = count;
      normalizedFacilities['bedrooms'] = count;
    } else if (normalizedKey.includes('bathroom')) {
      normalizedFacilities['bathroom'] = count;
      normalizedFacilities['bathrooms'] = count;
    } else {
      normalizedFacilities[key] = count;
    }
  });

  return {
    ...property,
    price: parseFloat(property.price) || 0,
    amenities: safeJsonParse(property.amenities),
    facilities: normalizedFacilities,
    images: safeJsonParse(property.images),
    latitude: property.latitude ? parseFloat(property.latitude) : null,
    longitude: property.longitude ? parseFloat(property.longitude) : null,
    views_count: parseInt(property.views_count) || 0,
  };
};

const validatePropertyId = (propertyId) => {
  const id = parseInt(propertyId);
  if (isNaN(id) || id <= 0) {
    throw new Error('Invalid property ID');
  }
  return id;
};

const handleApiError = (error, operation) => {
  console.error(`Error ${operation}:`, error);
  if (error.response?.status === 403) {
    throw new Error('You do not have permission for this action.');
  } else if (error.response?.status === 404) {
    throw new Error('Property not found');
  } else if (error.response?.status >= 500) {
    throw new Error('Server error. Please try again later.');
  }
  throw new Error(error.response?.data?.message || `Failed to ${operation}`);
};

// Storage configuration for property images
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 10 // Maximum 10 files
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files (JPEG, JPG, PNG, WebP) are allowed'));
    }
  }
});

/**
 * GET /api/properties/public
 * Get all public properties with filtering and pagination
 */
router.get('/public', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 12, 50);
    const offset = (page - 1) * limit;
    const { 
      search, 
      property_type, 
      unit_type, 
      min_price, 
      max_price, 
      min_bedrooms,
      max_bedrooms,
      min_bathrooms,
      max_bathrooms,
      amenities, 
      facilities,
      location,
      available_from,
      available_to,
      sort_by = 'created_at',
      sort_order = 'DESC'
    } = req.query;

    let whereClause = 'WHERE approval_status = ? AND is_active = ?';
    let queryParams = ['approved', 1];

    // Search functionality
    if (search) {
      whereClause += ' AND (address LIKE ? OR property_type LIKE ? OR unit_type LIKE ? OR description LIKE ?)';
      const searchTerm = `%${search}%`;
      queryParams.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    // Property type filter
    if (property_type) {
      whereClause += ' AND property_type = ?';
      queryParams.push(property_type);
    }

    // Unit type filter
    if (unit_type) {
      whereClause += ' AND unit_type = ?';
      queryParams.push(unit_type);
    }

    // Price range filters
    if (min_price !== null && min_price !== undefined) {
      const minPriceFloat = parseFloat(min_price);
      if (!isNaN(minPriceFloat)) {
        whereClause += ' AND price >= ?';
        queryParams.push(minPriceFloat);
      }
    }

    if (max_price !== null && max_price !== undefined) {
      const maxPriceFloat = parseFloat(max_price);
      if (!isNaN(maxPriceFloat)) {
        whereClause += ' AND price <= ?';
        queryParams.push(maxPriceFloat);
      }
    }

    // Bedroom filters
    if (min_bedrooms !== null && min_bedrooms !== undefined) {
      const minBed = parseInt(min_bedrooms);
      if (!isNaN(minBed)) {
        whereClause += ' AND bedrooms >= ?';
        queryParams.push(minBed);
      }
    }

    if (max_bedrooms !== null && max_bedrooms !== undefined) {
      const maxBed = parseInt(max_bedrooms);
      if (!isNaN(maxBed)) {
        whereClause += ' AND bedrooms <= ?';
        queryParams.push(maxBed);
      }
    }

    // Bathroom filters
    if (min_bathrooms !== null && min_bathrooms !== undefined) {
      const minBath = parseInt(min_bathrooms);
      if (!isNaN(minBath)) {
        whereClause += ' AND bathrooms >= ?';
        queryParams.push(minBath);
      }
    }

    if (max_bathrooms !== null && max_bathrooms !== undefined) {
      const maxBath = parseInt(max_bathrooms);
      if (!isNaN(maxBath)) {
        whereClause += ' AND bathrooms <= ?';
        queryParams.push(maxBath);
      }
    }

    // Location filter
    if (location) {
      whereClause += ' AND address LIKE ?';
      queryParams.push(`%${location}%`);
    }

    // Availability date filters
    if (available_from) {
      whereClause += ' AND (available_from IS NULL OR available_from <= ?)';
      queryParams.push(available_from);
    }

    if (available_to) {
      whereClause += ' AND (available_to IS NULL OR available_to >= ?)';
      queryParams.push(available_to);
    }

    // Amenities filter
    if (amenities) {
  const amenitiesList = amenities.split(',');
  for (const amenity of amenitiesList) {
    const trimmedAmenity = amenity.trim();
    // Use JSON_CONTAINS for better JSON handling
    whereClause += ' AND (JSON_CONTAINS(JSON_KEYS(amenities), JSON_QUOTE(?)) OR amenities LIKE ?)';
    queryParams.push(trimmedAmenity);
    queryParams.push(`%"${trimmedAmenity}"%`);
  }
}

    // Facilities filter
    if (facilities) {
  const facilitiesList = facilities.split(',');
  for (const facility of facilitiesList) {
    const trimmedFacility = facility.trim();
    // Use JSON_CONTAINS for better JSON handling
    whereClause += ' AND (JSON_CONTAINS(JSON_KEYS(facilities), JSON_QUOTE(?)) OR facilities LIKE ?)';
    queryParams.push(trimmedFacility);
    queryParams.push(`%"${trimmedFacility}"%`);
  }
}

    // Get total count for pagination
    const countQuery = `SELECT COUNT(*) as total FROM all_properties ${whereClause}`;
    const countResult = await query(countQuery, queryParams);
    const totalProperties = countResult[0].total;

    // Sorting
    const allowedSortFields = ['created_at', 'updated_at', 'price', 'views_count', 'property_type', 'unit_type'];
    const sortColumn = allowedSortFields.includes(sort_by) ? sort_by : 'created_at';
    const sortDirection = sort_order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Main query with sorting and pagination
    const propertiesQuery = `
      SELECT * FROM all_properties 
      ${whereClause}
      ORDER BY ${sortColumn} ${sortDirection}
      LIMIT ? OFFSET ?
    `;

    queryParams.push(limit, offset);
    const properties = await query(propertiesQuery, queryParams);

    const processedProperties = properties.map(processPropertyData);

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
        unit_type,
        min_price: min_price ? parseFloat(min_price) : null,
        max_price: max_price ? parseFloat(max_price) : null,
        min_bedrooms: min_bedrooms ? parseInt(min_bedrooms) : null,
        max_bedrooms: max_bedrooms ? parseInt(max_bedrooms) : null,
        min_bathrooms: min_bathrooms ? parseInt(min_bathrooms) : null,
        max_bathrooms: max_bathrooms ? parseInt(max_bathrooms) : null,
        amenities,
        facilities,
        location,
        available_from,
        available_to,
        sort_by,
        sort_order
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

/**
 * GET /api/properties/public/:id
 * Get a single public property by ID with owner information
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
        p.*,
        u.username as owner_name,
        u.email as owner_email,
        up.business_name as owner_business_name,
        up.phone as owner_phone,
        up.first_name as owner_first_name,
        up.last_name as owner_last_name
      FROM all_properties p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN user_profiles up ON u.id = up.user_id
      WHERE p.id = ? AND p.approval_status = ? AND p.is_active = ?
    `;

    const properties = await query(propertyQuery, [propertyId, 'approved', 1]);

    if (properties.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'The requested property could not be found or is not available'
      });
    }

    const property = properties[0];
    const processedProperty = {
      ...processPropertyData(property),
      owner_info: {
        username: property.owner_name,
        email: property.owner_email,
        business_name: property.owner_business_name,
        phone: property.owner_phone,
        first_name: property.owner_first_name,
        last_name: property.owner_last_name
      }
    };

    // Clean up temporary fields
    delete processedProperty.owner_name;
    delete processedProperty.owner_email;
    delete processedProperty.owner_business_name;
    delete processedProperty.owner_phone;
    delete processedProperty.owner_first_name;
    delete processedProperty.owner_last_name;

    // Increment views count
    try {
      await query(
        'UPDATE all_properties SET views_count = COALESCE(views_count, 0) + 1 WHERE id = ?',
        [propertyId]
      );
    } catch (viewError) {
      console.error('Error updating views count:', viewError);
    }

    // Record view if user is logged in
    if (req.user) {
      try {
        await query(
          'INSERT INTO user_interactions (user_id, property_id, interaction_type, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
          [req.user.id, propertyId, 'view']
        );
      } catch (interactionError) {
        console.error('Error recording user interaction:', interactionError);
      }
    }

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
 * GET /api/properties/types
 * Get available property types
 */
router.get('/types', async (req, res) => {
  try {
    const typesQuery = 'SELECT DISTINCT property_type FROM all_properties WHERE approval_status = "approved" AND is_active = 1 ORDER BY property_type';
    const types = await query(typesQuery);
    
    const propertyTypes = types.map(row => row.property_type);
    
    res.json(propertyTypes);
  } catch (error) {
    console.error('Error fetching property types:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch property types. Please try again.'
    });
  }
});

/**
 * GET /api/properties/unit-types
 * Get available unit types
 */
router.get('/unit-types', async (req, res) => {
  try {
    const typesQuery = 'SELECT DISTINCT unit_type FROM all_properties WHERE approval_status = "approved" AND is_active = 1 ORDER BY unit_type';
    const types = await query(typesQuery);
    
    const unitTypes = types.map(row => row.unit_type);
    
    res.json(unitTypes);
  } catch (error) {
    console.error('Error fetching unit types:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch unit types. Please try again.'
    });
  }
});

/**
 * GET /api/properties/search
 * Advanced property search
 */
router.get('/search', async (req, res) => {
  try {
    const {
      q,
      category,
      location,
      min_price,
      max_price,
      bedrooms,
      bathrooms,
      amenities,
      sort = 'relevance',
      page = 1,
      limit = 20
    } = req.query;

    let searchQuery = `
      SELECT *, 
        MATCH(property_type, unit_type, address, description) AGAINST(? IN NATURAL LANGUAGE MODE) as relevance_score
      FROM all_properties 
      WHERE approval_status = 'approved' AND is_active = 1
    `;
    
    let queryParams = [q || ''];

    if (q) {
      searchQuery += ' AND MATCH(property_type, unit_type, address, description) AGAINST(? IN NATURAL LANGUAGE MODE)';
      queryParams.push(q);
    }

    if (category) {
      searchQuery += ' AND property_type = ?';
      queryParams.push(category);
    }

    if (location) {
      searchQuery += ' AND address LIKE ?';
      queryParams.push(`%${location}%`);
    }

    if (min_price) {
      searchQuery += ' AND price >= ?';
      queryParams.push(parseFloat(min_price));
    }

    if (max_price) {
      searchQuery += ' AND price <= ?';
      queryParams.push(parseFloat(max_price));
    }

    if (bedrooms) {
      searchQuery += ' AND bedrooms = ?';
      queryParams.push(parseInt(bedrooms));
    }

    if (bathrooms) {
      searchQuery += ' AND bathrooms = ?';
      queryParams.push(parseInt(bathrooms));
    }

    // Sort options
    if (sort === 'price_low') {
      searchQuery += ' ORDER BY price ASC';
    } else if (sort === 'price_high') {
      searchQuery += ' ORDER BY price DESC';
    } else if (sort === 'newest') {
      searchQuery += ' ORDER BY created_at DESC';
    } else if (sort === 'popular') {
      searchQuery += ' ORDER BY views_count DESC';
    } else {
      searchQuery += ' ORDER BY relevance_score DESC, created_at DESC';
    }

    // Pagination
    const offset = (parseInt(page) - 1) * parseInt(limit);
    searchQuery += ' LIMIT ? OFFSET ?';
    queryParams.push(parseInt(limit), offset);

    const properties = await query(searchQuery, queryParams);
    const processedProperties = properties.map(processPropertyData);

    res.json({
      properties: processedProperties,
      total: properties.length,
      page: parseInt(page),
      limit: parseInt(limit)
    });

  } catch (error) {
    console.error('Error in property search:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to search properties. Please try again.'
    });
  }
});

/**
 * GET /api/properties/similar/:id
 * Get similar properties
 */
router.get('/similar/:id', async (req, res) => {
  const propertyId = req.params.id;
  const limit = Math.min(parseInt(req.query.limit) || 6, 20);

  try {
    // Get the base property
    const baseProperty = await query(
      'SELECT * FROM all_properties WHERE id = ?',
      [propertyId]
    );

    if (baseProperty.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'Base property not found'
      });
    }

    const base = baseProperty[0];

    // Find similar properties
    const similarQuery = `
      SELECT *, 
        (
          CASE WHEN property_type = ? THEN 3 ELSE 0 END +
          CASE WHEN unit_type = ? THEN 2 ELSE 0 END +
          CASE WHEN ABS(price - ?) < ? * 0.2 THEN 2 ELSE 0 END +
          CASE WHEN address LIKE ? THEN 1 ELSE 0 END
        ) as similarity_score
      FROM all_properties 
      WHERE id != ? 
        AND approval_status = 'approved' 
        AND is_active = 1
      HAVING similarity_score > 0
      ORDER BY similarity_score DESC, created_at DESC
      LIMIT ?
    `;

    const locationPattern = `%${base.address.split(',')[0]}%`;
    const similar = await query(similarQuery, [
      base.property_type,
      base.unit_type,
      base.price,
      base.price,
      locationPattern,
      propertyId,
      limit
    ]);

    const processedSimilar = similar.map(processPropertyData);

    res.json(processedSimilar);

  } catch (error) {
    console.error('Error fetching similar properties:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch similar properties. Please try again.'
    });
  }
});

/**
 * GET /api/properties/featured
 * Get featured properties
 */
router.get('/featured', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 8, 20);

    const featuredQuery = `
      SELECT * FROM all_properties 
      WHERE approval_status = 'approved' 
        AND is_active = 1
        AND (views_count > 10 OR created_at > DATE_SUB(NOW(), INTERVAL 30 DAY))
      ORDER BY views_count DESC, created_at DESC
      LIMIT ?
    `;

    const featured = await query(featuredQuery, [limit]);
    const processedFeatured = featured.map(processPropertyData);

    res.json(processedFeatured);

  } catch (error) {
    console.error('Error fetching featured properties:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch featured properties. Please try again.'
    });
  }
});

/**
 * GET /api/properties/owner/mine
 * Get owner's properties
 */
router.get('/owner/mine', auth, requirePropertyOwner, async (req, res) => {
  const userId = req.user.id;
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const offset = (page - 1) * limit;
  const { search, status, approval_status, sort_by = 'created_at', sort_order = 'DESC' } = req.query;

  try {
    let whereClause = 'WHERE ap.user_id = ?';
    let queryParams = [userId];

    // Status filter
    if (status && status !== 'all') {
      whereClause += ' AND ap.is_active = ?';
      queryParams.push(status === 'active' ? 1 : 0);
    }

    // Approval status filter
    if (approval_status && approval_status !== 'all') {
      whereClause += ' AND ap.approval_status = ?';
      queryParams.push(approval_status);
    }

    // Search filter
    if (search) {
      whereClause += ' AND (ap.address LIKE ? OR ap.property_type LIKE ? OR ap.unit_type LIKE ? OR ap.description LIKE ?)';
      const searchTerm = `%${search}%`;
      queryParams.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM all_properties ap ${whereClause}`;
    const countResult = await query(countQuery, queryParams);
    const totalProperties = countResult[0].total;

    // Sorting
    const allowedSortFields = ['created_at', 'updated_at', 'price', 'views_count', 'approval_status'];
    const sortColumn = allowedSortFields.includes(sort_by) ? `ap.${sort_by}` : 'ap.created_at';
    const sortDirection = sort_order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Main query
    const propertiesQuery = `
      SELECT ap.* FROM all_properties ap
      ${whereClause}
      ORDER BY ${sortColumn} ${sortDirection}
      LIMIT ? OFFSET ?
    `;

    queryParams.push(limit, offset);
    const properties = await query(propertiesQuery, queryParams);

    const processedProperties = properties.map(processPropertyData);

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
        status,
        approval_status,
        sort_by,
        sort_order
      }
    });

  } catch (error) {
    console.error('Error fetching owner properties:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch properties. Please try again.'
    });
  }
});

router.get('/owner/:id', auth, requirePropertyOwner, async (req, res) => {
  const propertyId = req.params.id;
  const userId = req.user.id;

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
        u.email as owner_email,
        up.business_name as owner_business_name,
        up.phone as owner_phone,
        up.first_name as owner_first_name,
        up.last_name as owner_last_name
      FROM all_properties p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN user_profiles up ON u.id = up.user_id
      WHERE p.id = ? AND p.user_id = ?
    `;

    const properties = await query(propertyQuery, [propertyId, userId]);

    if (properties.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'The requested property could not be found or you do not have access to it'
      });
    }

    const property = properties[0];
    const processedProperty = {
      ...processPropertyData(property),
      owner_info: {
        username: property.owner_name,
        email: property.owner_email,
        business_name: property.owner_business_name,
        phone: property.owner_phone,
        first_name: property.owner_first_name,
        last_name: property.owner_last_name
      }
    };

    // Clean up temporary fields
    delete processedProperty.owner_name;
    delete processedProperty.owner_email;
    delete processedProperty.owner_business_name;
    delete processedProperty.owner_phone;
    delete processedProperty.owner_first_name;
    delete processedProperty.owner_last_name;

    res.json(processedProperty);

  } catch (error) {
    console.error('Error fetching owner property:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch property. Please try again.'
    });
  }
});

/**
 * GET /api/properties/owner/statistics
 * Get owner's property statistics
 */
router.get('/owner/statistics', auth, requirePropertyOwner, async (req, res) => {
  const userId = req.user.id;

  try {
    const statsQuery = `
      SELECT 
        COUNT(*) as total_properties,
        COUNT(CASE WHEN approval_status = 'approved' THEN 1 END) as approved_properties,
        COUNT(CASE WHEN approval_status = 'pending' THEN 1 END) as pending_properties,
        COUNT(CASE WHEN approval_status = 'rejected' THEN 1 END) as rejected_properties,
        COUNT(CASE WHEN is_active = 1 THEN 1 END) as active_properties,
        SUM(views_count) as total_views,
        AVG(price) as average_price,
        MIN(price) as min_price,
        MAX(price) as max_price
      FROM all_properties 
      WHERE user_id = ?
    `;

    const stats = await query(statsQuery, [userId]);

    const bookingStatsQuery = `
      SELECT 
        COUNT(br.id) as total_bookings,
        COUNT(CASE WHEN br.status = 'pending' THEN 1 END) as pending_bookings,
        COUNT(CASE WHEN br.status = 'confirmed' THEN 1 END) as confirmed_bookings,
        COUNT(CASE WHEN br.status = 'cancelled' THEN 1 END) as cancelled_bookings,
        COALESCE(SUM(br.total_amount), 0) as total_revenue,
        COALESCE(SUM(br.advance_amount), 0) as advance_collected
      FROM booking_requests br
      INNER JOIN all_properties ap ON br.property_id = ap.id
      WHERE ap.user_id = ?
    `;

    const bookingStats = await query(bookingStatsQuery, [userId]);

    res.json({
      property_stats: stats[0],
      booking_stats: bookingStats[0],
      last_updated: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error fetching owner statistics:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch statistics. Please try again.'
    });
  }
});

/**
 * GET /api/properties/:id/stats
 * Get specific property statistics
 */
router.get('/:id/stats', auth, requirePropertyOwnership, async (req, res) => {
  const propertyId = req.params.id;

  try {
    // Get property details
    const propertyQuery = 'SELECT * FROM all_properties WHERE id = ? AND user_id = ?';
    const properties = await query(propertyQuery, [propertyId, req.user.id]);

    if (properties.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'Property not found or you do not have access to it'
      });
    }

    // Get booking statistics
    const bookingStatsQuery = `
      SELECT 
        COUNT(*) as total_bookings,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_bookings,
        COUNT(CASE WHEN status = 'confirmed' THEN 1 END) as confirmed_bookings,
        COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled_bookings,
        COALESCE(SUM(total_amount), 0) as total_revenue,
        COALESCE(SUM(advance_amount), 0) as advance_collected,
        COALESCE(AVG(total_amount), 0) as average_booking_value,
        COALESCE(AVG(advance_amount), 0) as average_advance_amount
      FROM booking_requests 
      WHERE property_id = ?
    `;

    // Get interaction statistics
    const interactionStatsQuery = `
      SELECT 
        COUNT(CASE WHEN interaction_type = 'view' THEN 1 END) as total_views,
        COUNT(CASE WHEN interaction_type = 'favorite' THEN 1 END) as total_favorites,
        COUNT(CASE WHEN interaction_type = 'rating' THEN 1 END) as total_ratings,
        COALESCE(AVG(CASE WHEN interaction_type = 'rating' THEN rating_score END), 0) as average_rating
      FROM user_interactions 
      WHERE property_id = ?
    `;

    const bookingStats = await query(bookingStatsQuery, [propertyId]);
    const interactionStats = await query(interactionStatsQuery, [propertyId]);
    
    const property = properties[0];
    const booking = bookingStats[0];
    const interaction = interactionStats[0];

    res.json({
      property: {
        id: property.id,
        property_type: property.property_type,
        unit_type: property.unit_type,
        address: property.address,
        price: parseFloat(property.price),
        is_active: property.is_active,
        approval_status: property.approval_status,
        views_count: property.views_count || 0,
        created_at: property.created_at
      },
      bookings: {
        total: parseInt(booking.total_bookings),
        pending: parseInt(booking.pending_bookings),
        confirmed: parseInt(booking.confirmed_bookings),
        cancelled: parseInt(booking.cancelled_bookings)
      },
      revenue: {
        total: parseFloat(booking.total_revenue),
        advance_collected: parseFloat(booking.advance_collected),
        average_booking_value: parseFloat(booking.average_booking_value),
        average_advance_amount: parseFloat(booking.average_advance_amount)
      },
      interactions: {
        total_views: parseInt(interaction.total_views),
        total_favorites: parseInt(interaction.total_favorites),
        total_ratings: parseInt(interaction.total_ratings),
        average_rating: parseFloat(interaction.average_rating)
      }
    });

  } catch (error) {
    console.error('Error fetching property stats:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch property statistics. Please try again.'
    });
  }
});

/**
 * GET /api/properties/:id
 * Get single property for owner
 */
router.get('/:id', auth, requirePropertyOwnership, async (req, res) => {
  const propertyId = req.params.id;

  if (!propertyId || isNaN(propertyId)) {
    return res.status(400).json({
      error: 'Invalid property ID',
      message: 'Property ID must be a valid number'
    });
  }

  try {
    const properties = await query(
      'SELECT * FROM all_properties WHERE id = ? AND user_id = ?',
      [propertyId, req.user.id]
    );

    if (properties.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'Property not found or you do not have access to it'
      });
    }

    const property = properties[0];
    const processedProperty = processPropertyData(property);

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
 * POST /api/properties
 * Create a new property
 */
router.post('/', auth, requirePropertyOwner, async (req, res) => {
  const propertyData = req.body;

  try {
    // Validate required fields
    const requiredFields = ['property_type', 'unit_type', 'address', 'description', 'price'];
    for (const field of requiredFields) {
      if (!propertyData[field]) {
        return res.status(400).json({
          error: 'Validation error',
          message: `${field} is required`
        });
      }
    }

    // Map frontend camelCase to backend snake_case
    const mappedData = {
      property_type: propertyData.property_type,
      unit_type: propertyData.unit_type,
      address: propertyData.address,
       latitude: propertyData.latitude || null,
      longitude: propertyData.longitude || null,
      description: propertyData.description,
      price: parseFloat(propertyData.price),
      bedrooms: parseInt(propertyData.bedrooms) || 0,
      bathrooms: parseInt(propertyData.bathrooms) || 0,
      available_from: propertyData.availableFrom ? dayjs(propertyData.availableFrom).format('YYYY-MM-DD') : null,
      available_to: propertyData.availableTo ? dayjs(propertyData.availableTo).format('YYYY-MM-DD') : null,
      contract_policy: propertyData.contractPolicy || '',
      amenities: propertyData.amenities || {},
      facilities: propertyData.facilities || {},
      images: propertyData.images || [],
      rules: propertyData.rules || [],
      roommates: propertyData.roommates || [],
      bills_inclusive: propertyData.billsInclusive || []
    };

    // Validate price
    if (isNaN(mappedData.price) || mappedData.price <= 0) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Price must be a valid positive number'
      });
    }

    const insertQuery = `
      INSERT INTO all_properties (
        user_id, property_type, unit_type, address, latitude, longitude, description, price,
        bedrooms, bathrooms, available_from, available_to, contract_policy, 
        amenities, facilities, images, rules, roommates, bills_inclusive,
        is_active, approval_status, views_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    `;

    const result = await query(insertQuery, [
      req.user.id,
      mappedData.property_type,
      mappedData.unit_type,
      mappedData.address,
      mappedData.latitude,
      mappedData.longitude,
      mappedData.description,
      mappedData.price,
      mappedData.bedrooms,
      mappedData.bathrooms,
      mappedData.available_from,
      mappedData.available_to,
      mappedData.contract_policy,
      JSON.stringify(mappedData.amenities),
      JSON.stringify(mappedData.facilities),
      JSON.stringify(mappedData.images),
      JSON.stringify(mappedData.rules),
      JSON.stringify(mappedData.roommates),
      JSON.stringify(mappedData.bills_inclusive),
      1, // is_active
      'pending', // approval_status
      0 // views_count
    ]);

    const newPropertyId = result.insertId;

    // Get the created property
    const createdProperty = await query(
      'SELECT * FROM all_properties WHERE id = ?',
      [newPropertyId]
    );

    const processedProperty = processPropertyData(createdProperty[0]);

    res.status(201).json(processedProperty);

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
 * Update a property
 */
router.put('/:id', auth, requirePropertyOwnership, async (req, res) => {
  const propertyId = req.params.id;
  const propertyData = req.body;

  if (!propertyId || isNaN(propertyId)) {
    return res.status(400).json({
      error: 'Invalid property ID',
      message: 'Property ID must be a valid number'
    });
  }

  try {
    // Map frontend camelCase to backend snake_case
    const mappedData = {
      property_type: propertyData.property_type,
      unit_type: propertyData.unit_type,
      address: propertyData.address,
      latitude: propertyData.latitude || null,
      longitude: propertyData.longitude || null,
      description: propertyData.description,
      price: parseFloat(propertyData.price),
      bedrooms: parseInt(propertyData.bedrooms) || 0,
      bathrooms: parseInt(propertyData.bathrooms) || 0,
      available_from: propertyData.available_from ? dayjs(propertyData.available_from).format('YYYY-MM-DD') : null,
      available_to: propertyData.available_to ? dayjs(propertyData.available_to).format('YYYY-MM-DD') : null,
      contract_policy: propertyData.contract_policy || propertyData.contractPolicy,
      amenities: propertyData.amenities || {},
      facilities: propertyData.facilities || {},
      images: propertyData.images || [],
      rules: propertyData.rules || [],
      roommates: propertyData.roommates || [],
      bills_inclusive: propertyData.bills_inclusive || propertyData.billsInclusive || []
    };

    const updateQuery = `
      UPDATE all_properties SET 
        property_type = ?, 
        unit_type = ?, 
        address = ?, 
        latitude = ?,
        longitude = ?,
        description = ?, 
        price = ?, 
        bedrooms = ?,
        bathrooms = ?,
        available_from = ?, 
        available_to = ?,
        contract_policy = ?, 
        amenities = ?, 
        facilities = ?, 
        images = ?,
        rules = ?,
        roommates = ?,
        bills_inclusive = ?,
        updated_at = NOW()
      WHERE id = ? AND user_id = ?
    `;

    const result = await query(updateQuery, [
      mappedData.property_type,
      mappedData.unit_type,
      mappedData.address,
      mappedData.latitude,
      mappedData.longitude,
      mappedData.description,
      mappedData.price,
      mappedData.bedrooms,
      mappedData.bathrooms,
      mappedData.available_from,
      mappedData.available_to,
      mappedData.contract_policy,
      JSON.stringify(mappedData.amenities),
      JSON.stringify(mappedData.facilities),
      JSON.stringify(mappedData.images),
      JSON.stringify(mappedData.rules),
      JSON.stringify(mappedData.roommates),
      JSON.stringify(mappedData.bills_inclusive),
      propertyId,
      req.user.id
    ]);

    if (result.affectedRows === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'Property not found or you do not have permission to update it'
      });
    }

    // Get updated property data
    const updatedProperty = await query(
      'SELECT * FROM all_properties WHERE id = ? AND user_id = ?',
      [propertyId, req.user.id]
    );

    const processedProperty = processPropertyData(updatedProperty[0]);

    res.json(processedProperty);

  } catch (error) {
    console.error('Error updating property:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to update property. Please try again.'
    });
  }
});

/**
 * PATCH /api/properties/:id/status
 * Toggle property active status
 */
router.patch('/:id/status', auth, requirePropertyOwnership, async (req, res) => {
  const propertyId = req.params.id;
  const { is_active } = req.body;

  if (typeof is_active !== 'boolean') {
    return res.status(400).json({
      error: 'Invalid status',
      message: 'is_active must be a boolean value'
    });
  }

  try {
    const result = await query(
      'UPDATE all_properties SET is_active = ?, updated_at = NOW() WHERE id = ? AND user_id = ?',
      [is_active, propertyId, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'Property not found or you do not have permission to update it'
      });
    }

    res.json({
      message: `Property ${is_active ? 'activated' : 'deactivated'} successfully`,
      property_id: parseInt(propertyId),
      is_active: is_active
    });

  } catch (error) {
    console.error('Error updating property status:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to update property status. Please try again.'
    });
  }
});

/**
 * POST /api/properties/:id/images
 * Upload property images
 */
router.post('/:id/images', auth, requirePropertyOwnership, upload.array('images', 10), async (req, res) => {
  const propertyId = req.params.id;

  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        error: 'No images provided',
        message: 'At least one image file is required'
      });
    }

    // Get current property
    const property = await query(
      'SELECT images FROM all_properties WHERE id = ? AND user_id = ?',
      [propertyId, req.user.id]
    );

    if (property.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'Property not found or you do not have access to it'
      });
    }

    const currentImages = safeJsonParse(property[0].images);
    const uploadedImages = [];

    // Process uploaded files (This would integrate with your image upload service)
    for (const file of req.files) {
      const imageData = {
        url: `/uploads/properties/${propertyId}/${file.filename}`,
        filename: file.filename,
        originalname: file.originalname,
        size: file.size,
        mimetype: file.mimetype
      };
      uploadedImages.push(imageData);
    }

    // Combine with existing images
    const allImages = [...currentImages, ...uploadedImages];

    // Update property with new images
    await query(
      'UPDATE all_properties SET images = ?, updated_at = NOW() WHERE id = ? AND user_id = ?',
      [JSON.stringify(allImages), propertyId, req.user.id]
    );

    res.json({
      message: 'Images uploaded successfully',
      images: uploadedImages,
      total_images: allImages.length
    });

  } catch (error) {
    console.error('Error uploading property images:', error);
    res.status(500).json({
      error: 'Upload error',
      message: 'Unable to upload images. Please try again.'
    });
  }
});

/**
 * DELETE /api/properties/:id/images/:imageId
 * Delete a property image
 */
router.delete('/:id/images/:imageId', auth, requirePropertyOwnership, async (req, res) => {
  const { id: propertyId, imageId } = req.params;

  try {
    // Get current property
    const property = await query(
      'SELECT images FROM all_properties WHERE id = ? AND user_id = ?',
      [propertyId, req.user.id]
    );

    if (property.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'Property not found or you do not have access to it'
      });
    }

    const currentImages = safeJsonParse(property[0].images);
    const imageIndex = parseInt(imageId);

    if (imageIndex < 0 || imageIndex >= currentImages.length) {
      return res.status(404).json({
        error: 'Image not found',
        message: 'Image index is invalid'
      });
    }

    // Remove image from array
    const updatedImages = currentImages.filter((_, index) => index !== imageIndex);

    // Update property
    await query(
      'UPDATE all_properties SET images = ?, updated_at = NOW() WHERE id = ? AND user_id = ?',
      [JSON.stringify(updatedImages), propertyId, req.user.id]
    );

    res.json({
      message: 'Image deleted successfully',
      remaining_images: updatedImages.length
    });

  } catch (error) {
    console.error('Error deleting property image:', error);
    res.status(500).json({
      error: 'Delete error',
      message: 'Unable to delete image. Please try again.'
    });
  }
});

/**
 * POST /api/properties/:id/duplicate
 * Duplicate a property
 */
router.post('/:id/duplicate', auth, requirePropertyOwnership, async (req, res) => {
  const propertyId = req.params.id;

  try {
    // Get original property
    const originalProperty = await query(
      'SELECT * FROM all_properties WHERE id = ? AND user_id = ?',
      [propertyId, req.user.id]
    );

    if (originalProperty.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'Property not found or you do not have access to it'
      });
    }

    const original = originalProperty[0];

    // Create duplicate
    const insertQuery = `
      INSERT INTO all_properties (
        user_id, property_type, unit_type, address, description, price,
        bedrooms, bathrooms, available_from, available_to, contract_policy,
        amenities, facilities, images, rules, roommates, bills_inclusive,
        is_active, approval_status, views_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    `;

    const result = await query(insertQuery, [
      req.user.id,
      original.property_type,
      original.unit_type,
      `${original.address} (Copy)`,
      original.description,
      original.price,
      original.bedrooms,
      original.bathrooms,
      original.available_from,
      original.available_to,
      original.contract_policy,
      original.amenities,
      original.facilities,
      '[]', // Clear images for duplicate
      original.rules,
      original.roommates,
      original.bills_inclusive,
      0, // Inactive by default
      'pending',
      0
    ]);

    const newPropertyId = result.insertId;

    // Get duplicated property
    const duplicatedProperty = await query(
      'SELECT * FROM all_properties WHERE id = ?',
      [newPropertyId]
    );

    const processedProperty = processPropertyData(duplicatedProperty[0]);

    res.status(201).json(processedProperty);

  } catch (error) {
    console.error('Error duplicating property:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to duplicate property. Please try again.'
    });
  }
});

/**
 * DELETE /api/properties/:id
 * Delete a property
 */
router.delete('/:id', auth, requirePropertyOwnership, async (req, res) => {
  const propertyId = req.params.id;

  try {
    const transactionQueries = [
      {
        sql: 'DELETE FROM user_interactions WHERE property_id = ?',
        params: [propertyId]
      },
      {
        sql: 'DELETE FROM booking_requests WHERE property_id = ?',
        params: [propertyId]
      },
      {
        sql: 'DELETE FROM all_properties WHERE id = ? AND user_id = ?',
        params: [propertyId, req.user.id]
      }
    ];

    const results = await executeTransaction(transactionQueries);

    if (results[results.length - 1].affectedRows === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'Property not found or you do not have permission to delete it'
      });
    }

    res.json({
      message: 'Property deleted successfully',
      property_id: parseInt(propertyId)
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
 * GET /api/properties/owner/dashboard
 * Get property owner dashboard data with stats and recent properties
 */
router.get('/owner/dashboard', auth, requirePropertyOwner, async (req, res) => {
  const userId = req.user.id;

  try {
    // Get property statistics
    const statsQuery = `
      SELECT 
        COUNT(*) as total_properties,
        COUNT(CASE WHEN approval_status = 'approved' THEN 1 END) as approved_properties,
        COUNT(CASE WHEN approval_status = 'pending' THEN 1 END) as pending_properties,
        COUNT(CASE WHEN approval_status = 'rejected' THEN 1 END) as rejected_properties,
        COUNT(CASE WHEN is_active = 1 THEN 1 END) as active_properties,
        SUM(views_count) as total_views,
        AVG(price) as average_price
      FROM all_properties 
      WHERE user_id = ?
    `;

    const propertyStats = await query(statsQuery, [userId]);

    // Get booking statistics
    const bookingStatsQuery = `
      SELECT 
        COUNT(br.id) as total_bookings,
        COUNT(CASE WHEN br.status = 'pending' THEN 1 END) as pending_bookings,
        COUNT(CASE WHEN br.status = 'confirmed' THEN 1 END) as confirmed_bookings,
        COUNT(CASE WHEN br.status = 'cancelled' THEN 1 END) as cancelled_bookings,
        COALESCE(SUM(br.total_price), 0) as total_revenue,
        COALESCE(SUM(br.advance_amount), 0) as advance_collected
      FROM booking_requests br
      INNER JOIN all_properties ap ON br.property_id = ap.id
      WHERE ap.user_id = ?
    `;

    const bookingStats = await query(bookingStatsQuery, [userId]);

    // Get recent properties (last 5)
    const recentPropertiesQuery = `
      SELECT ap.id, ap.property_type, ap.unit_type, ap.address, ap.price, 
             ap.approval_status, ap.is_active, ap.views_count, ap.created_at,
             ap.images, ap.amenities, ap.facilities
      FROM all_properties ap
      WHERE ap.user_id = ?
      ORDER BY ap.created_at DESC
      LIMIT 5
    `;

    const recentProperties = await query(recentPropertiesQuery, [userId]);

    // Get recent bookings
    const recentBookingsQuery = `
      SELECT br.id, br.first_name, br.last_name, br.status, 
             br.check_in_date, br.check_out_date, br.total_price, 
             br.advance_amount, br.created_at,
             ap.property_type, ap.address as property_address
      FROM booking_requests br
      INNER JOIN all_properties ap ON br.property_id = ap.id
      WHERE ap.user_id = ?
      ORDER BY br.created_at DESC
      LIMIT 5
    `;

    const recentBookings = await query(recentBookingsQuery, [userId]);

    // Process properties data
    const processedProperties = recentProperties.map(property => {
      const processedProperty = { ...property };
      
      try {
        processedProperty.images = property.images ? JSON.parse(property.images) : [];
      } catch (e) {
        processedProperty.images = [];
      }
      
      try {
        processedProperty.amenities = property.amenities ? JSON.parse(property.amenities) : {};
      } catch (e) {
        processedProperty.amenities = {};
      }
      
      try {
        processedProperty.facilities = property.facilities ? JSON.parse(property.facilities) : {};
      } catch (e) {
        processedProperty.facilities = {};
      }
      
      return processedProperty;
    });

    res.json({
      stats: {
        property_stats: propertyStats[0],
        booking_stats: bookingStats[0]
      },
      recent_properties: processedProperties,
      recent_bookings: recentBookings,
      last_updated: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error fetching owner dashboard:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch dashboard data. Please try again.'
    });
  }
});

module.exports = router;