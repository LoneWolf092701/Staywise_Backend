const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const db = require('../config/db');
const { upload, uploadToCloudinary } = require('../middleware/upload');

function safeJsonParse(jsonString) {
  if (!jsonString) return null;
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    console.warn('Invalid JSON string:', jsonString);
    return null;
  }
}

function requirePropertyOwnerRole(req, res, next) {
  if (req.user.role !== 'propertyowner') {
    return res.status(403).json({ 
      error: 'Access denied',
      message: 'Property owner role required',
      redirectTo: '/login'
    });
  }
  next();
}

router.post('/', auth, requirePropertyOwnerRole, (req, res) => {
  const { title, description, price, location } = req.body;
  const userId = req.user.id; 

  if (!title || !description || !price || !location) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      message: 'Title, description, price, and location are required'
    });
  }

  db.query(
    'INSERT INTO properties (user_id, title, description, price, location) VALUES (?, ?, ?, ?, ?)',
    [userId, title, description, price, location],
    (err, results) => {
      if (err) {
        console.error('Error adding property:', err);
        return res.status(500).json({ error: 'Error adding property' });
      }
      res.status(201).json({ 
        message: 'Property added successfully', 
        propertyId: results.insertId,
        redirectTo: '/myproperties'
      });
    }
  );
});

router.get('/', auth, requirePropertyOwnerRole, (req, res) => {
  const userId = req.user.id;

  db.query('SELECT * FROM properties WHERE user_id = ? ORDER BY created_at DESC', [userId], (err, results) => {
    if (err) {
      console.error('Error fetching properties:', err);
      return res.status(500).json({ error: 'Error fetching properties' });
    }
    res.json(results);
  });
});

router.put('/:id', auth, requirePropertyOwnerRole, (req, res) => {
  const { title, description, price, location } = req.body;
  const propertyId = req.params.id;
  const userId = req.user.id;

  if (!title || !description || !price || !location) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      message: 'Title, description, price, and location are required'
    });
  }

  db.query(
    'SELECT * FROM properties WHERE id = ? AND user_id = ?',
    [propertyId, userId],
    (err, results) => {
      if (err) {
        console.error('Error finding property:', err);
        return res.status(500).json({ error: 'Error finding property' });
      }
      if (results.length === 0) {
        return res.status(404).json({ 
          error: 'Property not found or not owned by user',
          redirectTo: '/myproperties'
        });
      }

      db.query(
        'UPDATE properties SET title = ?, description = ?, price = ?, location = ?, updated_at = NOW() WHERE id = ?',
        [title, description, price, location, propertyId],
        (err, results) => {
          if (err) {
            console.error('Error updating property:', err);
            return res.status(500).json({ error: 'Error updating property' });
          }
          res.json({ 
            message: 'Property updated successfully',
            redirectTo: '/myproperties'
          });
        }
      );
    }
  );
});

router.delete('/:id', auth, requirePropertyOwnerRole, (req, res) => {
  const propertyId = req.params.id;
  const userId = req.user.id;

  db.query(
    'SELECT * FROM properties WHERE id = ? AND user_id = ?',
    [propertyId, userId],
    (err, results) => {
      if (err) {
        console.error('Error finding property:', err);
        return res.status(500).json({ error: 'Error finding property' });
      }
      if (results.length === 0) {
        return res.status(404).json({ 
          error: 'Property not found or not owned by user',
          redirectTo: '/myproperties'
        });
      }

      db.query('DELETE FROM properties WHERE id = ?', [propertyId], (err, results) => {
        if (err) {
          console.error('Error deleting property:', err);
          return res.status(500).json({ error: 'Error deleting property' });
        }
        res.json({ 
          message: 'Property deleted successfully',
          redirectTo: '/myproperties'
        });
      });
    }
  );
});

router.post('/details', auth, requirePropertyOwnerRole, (req, res) => {
  const {
    propertyType,
    unitType,
    selectedAmenities,
    facilities,
    otherFacility,
    roommates,
    rules,
    contractPolicy,
    address,
    availableFrom,
    availableTo,
    priceRange,
    billsInclusive
  } = req.body;
  const userId = req.user.id;

  if (!propertyType || !unitType || !address) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      message: 'Property type, unit type, and address are required'
    });
  }

  const propertyData = [
    userId,
    propertyType,
    unitType,
    JSON.stringify(selectedAmenities || []),
    JSON.stringify(facilities || {}),
    otherFacility || null,
    JSON.stringify(roommates || {}),
    JSON.stringify(rules || []),
    contractPolicy || null,
    address,
    availableFrom || null,
    availableTo || null,
    JSON.stringify(priceRange || {}),
    JSON.stringify(billsInclusive || [])
  ];

  db.query(
    `INSERT INTO property_details 
      (user_id, property_type, unit_type, amenities, facilities, other_facility, roommates, rules, contract_policy, address, available_from, available_to, price_range, bills_inclusive) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    propertyData,
    (err, results) => {
      if (err) {
        console.error('Error inserting property details:', err);
        return res.status(500).json({ error: 'Error adding property details' });
      }
      const insertedId = results.insertId;

      res.status(201).json({ 
        message: 'Property details added successfully',
        propertyId: insertedId,
        status: 'pending_approval',
        redirectTo: '/myproperties'
      });
    }
  );
});

router.get('/details', auth, requirePropertyOwnerRole, (req, res) => {
  const userId = req.user.id;

  db.query(
    'SELECT * FROM property_details WHERE user_id = ? AND is_deleted = 0 ORDER BY created_at DESC',
    [userId],
    (err, results) => {
      if (err) {
        console.error('Error fetching property details:', err);
        return res.status(500).json({ error: 'Error fetching properties' });
      }

      const processedResults = results.map(property => ({
        ...property,
        amenities: safeJsonParse(property.amenities),
        facilities: safeJsonParse(property.facilities),
        roommates: safeJsonParse(property.roommates),
        rules: safeJsonParse(property.rules),
        price_range: safeJsonParse(property.price_range),
        bills_inclusive: safeJsonParse(property.bills_inclusive)
      }));

      res.json(processedResults);
    }
  );
});

router.get('/details/:id', auth, requirePropertyOwnerRole, (req, res) => {
  const propertyId = req.params.id;
  const userId = req.user.id;

  const query = 'SELECT * FROM property_details WHERE id = ? AND user_id = ? AND is_deleted = 0';
  
  db.query(query, [propertyId, userId], (err, results) => {
    if (err) {
      console.error('Error fetching property detail:', err);
      return res.status(500).json({error: 'Error fetching property details'});
    }
    
    if (results.length === 0) {
      return res.status(404).json({
        error: 'Property not found or not owned by user',
        redirectTo: '/myproperties'
      });
    }
    
    const property = results[0];
    const processedProperty = {
      ...property,
      amenities: safeJsonParse(property.amenities),
      facilities: safeJsonParse(property.facilities),
      roommates: safeJsonParse(property.roommates),
      rules: safeJsonParse(property.rules),
      price_range: safeJsonParse(property.price_range),
      bills_inclusive: safeJsonParse(property.bills_inclusive)
    };
    
    res.json(processedProperty);
  });
});

router.get('/public/:id', (req, res) => {
  const propertyId = req.params.id;
  
  const query = `
    SELECT ap.*, u.username as owner_username 
    FROM all_properties ap
    LEFT JOIN users u ON ap.user_id = u.id
    WHERE ap.id = ? AND ap.is_active = 1
  `;
  
  db.query(query, [propertyId], (err, results) => {
    if (err) {
      console.error('Error fetching property detail:', err);
      return res.status(500).json({error: 'Error fetching property details'});
    }
    
    if (results.length === 0) {
      return res.status(404).json({
        error: 'Property not found or not available',
        redirectTo: '/user-allproperties'
      });
    }
    
    const property = results[0];
    const processedProperty = {
      ...property,
      amenities: safeJsonParse(property.amenities),
      facilities: safeJsonParse(property.facilities),
      roommates: safeJsonParse(property.roommates),
      rules: safeJsonParse(property.rules),
      price_range: safeJsonParse(property.price_range),
      bills_inclusive: safeJsonParse(property.bills_inclusive)
    };
    
    db.query(
      'UPDATE all_properties SET views_count = COALESCE(views_count, 0) + 1 WHERE id = ?',
      [propertyId],
      (err) => {
        if (err) {
          console.error('Error updating view count:', err);
        }
      }
    );
    
    res.json(processedProperty);
  });
});

router.get('/public', (req, res) => {
  const { limit, search, location, propertyType, minPrice, maxPrice } = req.query;
  
  let query = `
    SELECT ap.*, u.username as owner_username,
           COALESCE(ap.views_count, 0) as views_count
    FROM all_properties ap
    LEFT JOIN users u ON ap.user_id = u.id
    WHERE ap.is_active = 1
  `;
  
  const queryParams = [];
  
  if (search) {
    query += ` AND (ap.property_type LIKE ? OR ap.unit_type LIKE ? OR ap.address LIKE ?)`;
    const searchTerm = `%${search}%`;
    queryParams.push(searchTerm, searchTerm, searchTerm);
  }
  
  if (location) {
    query += ` AND ap.address LIKE ?`;
    queryParams.push(`%${location}%`);
  }
  
  if (propertyType) {
    query += ` AND ap.property_type = ?`;
    queryParams.push(propertyType);
  }
  
  if (minPrice) {
    query += ` AND ap.price >= ?`;
    queryParams.push(parseFloat(minPrice));
  }
  
  if (maxPrice) {
    query += ` AND ap.price <= ?`;
    queryParams.push(parseFloat(maxPrice));
  }
  
  query += ` ORDER BY ap.created_at DESC`;
  
  if (limit) {
    query += ` LIMIT ?`;
    queryParams.push(parseInt(limit));
  }
  
  db.query(query, queryParams, (err, results) => {
    if (err) {
      console.error('Error fetching properties:', err);
      return res.status(500).json({ error: 'Error fetching properties' });
    }
    
    const processedResults = results.map(property => ({
      ...property,
      amenities: safeJsonParse(property.amenities),
      facilities: safeJsonParse(property.facilities),
      roommates: safeJsonParse(property.roommates),
      rules: safeJsonParse(property.rules),
      price_range: safeJsonParse(property.price_range),
      bills_inclusive: safeJsonParse(property.bills_inclusive)
    }));
    
    res.json(processedResults);
  });
});

router.post('/upload', auth, requirePropertyOwnerRole, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  try {
    const result = await uploadToCloudinary(req.file.buffer, req.file.originalname);
    res.status(200).json({ 
      cloudUrl: result.secure_url,
      publicId: result.public_id,
      message: 'Image uploaded successfully'
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ 
      error: 'Image upload failed', 
      details: error.message 
    });
  }
});

router.put('/details/:id', auth, requirePropertyOwnerRole, (req, res) => {
  const propertyId = req.params.id;
  const userId = req.user.id;
  const {
    propertyType,
    unitType,
    selectedAmenities,
    facilities,
    otherFacility,
    roommates,
    rules,
    contractPolicy,
    address,
    availableFrom,
    availableTo,
    priceRange,
    billsInclusive
  } = req.body;

  if (!propertyType || !unitType || !address) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      message: 'Property type, unit type, and address are required'
    });
  }

  db.query(
    'SELECT * FROM property_details WHERE id = ? AND user_id = ? AND is_deleted = 0',
    [propertyId, userId],
    (err, results) => {
      if (err) {
        console.error('Error checking property ownership:', err);
        return res.status(500).json({ error: 'Error verifying property ownership' });
      }
      
      if (results.length === 0) {
        return res.status(404).json({ 
          error: 'Property not found or not owned by user',
          redirectTo: '/myproperties'
        });
      }

      const updateQuery = `
        UPDATE property_details 
        SET property_type = ?, unit_type = ?, amenities = ?, facilities = ?, 
            other_facility = ?, roommates = ?, rules = ?, contract_policy = ?, 
            address = ?, available_from = ?, available_to = ?, price_range = ?, 
            bills_inclusive = ?, updated_at = NOW()
        WHERE id = ? AND user_id = ?
      `;

      const updateValues = [
        propertyType,
        unitType,
        JSON.stringify(selectedAmenities || []),
        JSON.stringify(facilities || {}),
        otherFacility || null,
        JSON.stringify(roommates || {}),
        JSON.stringify(rules || []),
        contractPolicy || null,
        address,
        availableFrom || null,
        availableTo || null,
        JSON.stringify(priceRange || {}),
        JSON.stringify(billsInclusive || []),
        propertyId,
        userId
      ];

      db.query(updateQuery, updateValues, (err, results) => {
        if (err) {
          console.error('Error updating property details:', err);
          return res.status(500).json({ error: 'Error updating property details' });
        }

        res.json({ 
          message: 'Property updated successfully',
          redirectTo: '/myproperties'
        });
      });
    }
  );
});

router.delete('/details/:id', auth, requirePropertyOwnerRole, (req, res) => {
  const propertyId = req.params.id;
  const userId = req.user.id;

  db.query(
    'UPDATE property_details SET is_deleted = 1, updated_at = NOW() WHERE id = ? AND user_id = ?',
    [propertyId, userId],
    (err, results) => {
      if (err) {
        console.error('Error deleting property:', err);
        return res.status(500).json({ error: 'Error deleting property' });
      }
      
      if (results.affectedRows === 0) {
        return res.status(404).json({ 
          error: 'Property not found or not owned by user',
          redirectTo: '/myproperties'
        });
      }

      db.query(
        'UPDATE all_properties SET is_active = 0, updated_at = NOW() WHERE id = ?',
        [propertyId],
        (err, results) => {
          if (err) {
            console.error('Error deactivating from all_properties:', err);
          }
          
          res.json({ 
            message: 'Property deleted successfully',
            redirectTo: '/myproperties'
          });
        }
      );
    }
  );
});

router.get('/search', (req, res) => {
  const { 
    q: searchQuery, 
    location, 
    propertyType, 
    minPrice, 
    maxPrice, 
    sortBy = 'created_at', 
    sortOrder = 'DESC',
    page = 1,
    limit = 20
  } = req.query;

  let query = `
    SELECT ap.*, u.username as owner_username,
           COALESCE(ap.views_count, 0) as views_count,
           COUNT(*) OVER() as total_count
    FROM all_properties ap
    LEFT JOIN users u ON ap.user_id = u.id
    WHERE ap.is_active = 1
  `;
  
  const queryParams = [];
  
  if (searchQuery) {
    query += ` AND (ap.property_type LIKE ? OR ap.unit_type LIKE ? OR ap.address LIKE ?)`;
    const searchTerm = `%${searchQuery}%`;
    queryParams.push(searchTerm, searchTerm, searchTerm);
  }
  
  if (location) {
    query += ` AND ap.address LIKE ?`;
    queryParams.push(`%${location}%`);
  }
  
  if (propertyType) {
    query += ` AND ap.property_type = ?`;
    queryParams.push(propertyType);
  }
  
  if (minPrice) {
    query += ` AND ap.price >= ?`;
    queryParams.push(parseFloat(minPrice));
  }
  
  if (maxPrice) {
    query += ` AND ap.price <= ?`;
    queryParams.push(parseFloat(maxPrice));
  }
  
  const validSortFields = ['created_at', 'price', 'rating', 'views_count'];
  const validSortOrders = ['ASC', 'DESC'];
  
  const safeSortBy = validSortFields.includes(sortBy) ? sortBy : 'created_at';
  const safeSortOrder = validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC';
  
  query += ` ORDER BY ap.${safeSortBy} ${safeSortOrder}`;
  
  const offset = (parseInt(page) - 1) * parseInt(limit);
  query += ` LIMIT ? OFFSET ?`;
  queryParams.push(parseInt(limit), offset);
  
  db.query(query, queryParams, (err, results) => {
    if (err) {
      console.error('Error searching properties:', err);
      return res.status(500).json({ error: 'Error searching properties' });
    }
    
    const processedResults = results.map(property => ({
      ...property,
      amenities: safeJsonParse(property.amenities),
      facilities: safeJsonParse(property.facilities),
      roommates: safeJsonParse(property.roommates),
      rules: safeJsonParse(property.rules),
      price_range: safeJsonParse(property.price_range),
      bills_inclusive: safeJsonParse(property.bills_inclusive)
    }));
    
    const totalCount = results.length > 0 ? results[0].total_count : 0;
    const totalPages = Math.ceil(totalCount / parseInt(limit));
    
    res.json({
      properties: processedResults,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalCount,
        hasNext: parseInt(page) < totalPages,
        hasPrev: parseInt(page) > 1
      }
    });
  });
});

router.get('/stats', auth, requirePropertyOwnerRole, (req, res) => {
  const userId = req.user.id;
  
  const statsQuery = `
    SELECT 
      (SELECT COUNT(*) FROM property_details WHERE user_id = ? AND is_deleted = 0) as total_properties,
      (SELECT COUNT(*) FROM property_details WHERE user_id = ? AND approval_status = 'approved' AND is_deleted = 0) as approved_properties,
      (SELECT COUNT(*) FROM property_details WHERE user_id = ? AND approval_status = 'pending' AND is_deleted = 0) as pending_properties,
      (SELECT COUNT(*) FROM booking_requests WHERE property_owner_id = ?) as total_bookings,
      (SELECT COUNT(*) FROM booking_requests WHERE property_owner_id = ? AND status = 'confirmed') as confirmed_bookings,
      (SELECT COALESCE(SUM(views_count), 0) FROM all_properties WHERE user_id = ?) as total_views
  `;
  
  db.query(statsQuery, [userId, userId, userId, userId, userId, userId], (err, results) => {
    if (err) {
      console.error('Error fetching property stats:', err);
      return res.status(500).json({ error: 'Error fetching statistics' });
    }
    
    const stats = results[0];
    
    res.json({
      properties: {
        total: stats.total_properties,
        approved: stats.approved_properties,
        pending: stats.pending_properties
      },
      bookings: {
        total: stats.total_bookings,
        confirmed: stats.confirmed_bookings
      },
      engagement: {
        totalViews: stats.total_views
      }
    });
  });
});

module.exports = router;