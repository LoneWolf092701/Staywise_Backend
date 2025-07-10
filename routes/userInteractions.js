const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');

/**
 * POST /api/user-interactions/rating
 * Submit or update a property rating with proper aggregation
 */
router.post('/rating', auth, (req, res) => {
  const { property_id, rating } = req.body;
  const user_id = req.user.id;

  // Input validation
  if (!property_id || isNaN(property_id)) {
    return res.status(400).json({ error: 'Valid Property ID is required' });
  }

  if (!rating || isNaN(rating)) {
    return res.status(400).json({ error: 'Rating is required and must be a number' });
  }

  const ratingValue = parseInt(rating);
  if (ratingValue < 1 || ratingValue > 5) {
    return res.status(400).json({ error: 'Rating must be an integer between 1 and 5' });
  }

  // Start transaction for rating update and aggregation
  db.getConnection((err, connection) => {
    if (err) {
      console.error('Error getting connection:', err);
      return res.status(500).json({ error: 'Database connection error' });
    }

    connection.beginTransaction((err) => {
      if (err) {
        connection.release();
        console.error('Error starting transaction:', err);
        return res.status(500).json({ error: 'Transaction error' });
      }

      // Verify property exists and get owner information
      connection.query(
        'SELECT id, user_id, is_active FROM all_properties WHERE id = ?',
        [property_id],
        (err, propertyResults) => {
          if (err) {
            return connection.rollback(() => {
              connection.release();
              console.error('Error verifying property:', err);
              res.status(500).json({ error: 'Error verifying property' });
            });
          }

          if (propertyResults.length === 0) {
            return connection.rollback(() => {
              connection.release();
              res.status(404).json({ error: 'Property not found' });
            });
          }

          if (propertyResults[0].is_active !== 1) {
            return connection.rollback(() => {
              connection.release();
              res.status(400).json({ error: 'Cannot rate inactive property' });
            });
          }

          // Prevent property owners from rating their own properties
          if (propertyResults[0].user_id === user_id) {
            return connection.rollback(() => {
              connection.release();
              res.status(400).json({ error: 'Property owners cannot rate their own properties' });
            });
          }

          // Check if user has already rated this property
          connection.query(
            'SELECT rating FROM user_property_interactions WHERE user_id = ? AND property_id = ?',
            [user_id, property_id],
            (err, existingResults) => {
              if (err) {
                return connection.rollback(() => {
                  connection.release();
                  console.error('Error checking existing rating:', err);
                  res.status(500).json({ error: 'Error checking existing rating' });
                });
              }

              const isUpdate = existingResults.length > 0 && existingResults[0].rating !== null;

              // Update or insert the user's rating
              if (existingResults.length > 0) {
                connection.query(
                  'UPDATE user_property_interactions SET rating = ?, updated_at = NOW() WHERE user_id = ? AND property_id = ?',
                  [ratingValue, user_id, property_id],
                  (err) => {
                    if (err) {
                      return connection.rollback(() => {
                        connection.release();
                        console.error('Error updating rating:', err);
                        res.status(500).json({ error: 'Error updating rating' });
                      });
                    }
                    updatePropertyRating();
                  }
                );
              } else {
                connection.query(
                  'INSERT INTO user_property_interactions (user_id, property_id, rating, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
                  [user_id, property_id, ratingValue],
                  (err) => {
                    if (err) {
                      return connection.rollback(() => {
                        connection.release();
                        console.error('Error inserting rating:', err);
                        res.status(500).json({ error: 'Error inserting rating' });
                      });
                    }
                    updatePropertyRating();
                  }
                );
              }

              // Function to update property aggregate rating
              function updatePropertyRating() {
                connection.query(
                  `SELECT 
                    COUNT(*) as total_ratings,
                    AVG(rating) as average_rating,
                    SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) as five_star,
                    SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END) as four_star,
                    SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) as three_star,
                    SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) as two_star,
                    SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) as one_star
                  FROM user_property_interactions 
                  WHERE property_id = ? AND rating IS NOT NULL`,
                  [property_id],
                  (err, statsResults) => {
                    if (err) {
                      return connection.rollback(() => {
                        connection.release();
                        console.error('Error calculating rating stats:', err);
                        res.status(500).json({ error: 'Error calculating rating stats' });
                      });
                    }

                    const stats = statsResults[0];
                    
                    // Update the property's aggregate rating information
                    connection.query(
                      `UPDATE all_properties 
                      SET 
                        rating = ?,
                        total_ratings = ?,
                        rating_distribution = ?,
                        updated_at = NOW()
                      WHERE id = ?`,
                      [
                        parseFloat(stats.average_rating).toFixed(2),
                        stats.total_ratings,
                        JSON.stringify({
                          five_star: stats.five_star,
                          four_star: stats.four_star,
                          three_star: stats.three_star,
                          two_star: stats.two_star,
                          one_star: stats.one_star
                        }),
                        property_id
                      ],
                      (err) => {
                        if (err) {
                          return connection.rollback(() => {
                            connection.release();
                            console.error('Error updating property rating:', err);
                            res.status(500).json({ error: 'Error updating property rating' });
                          });
                        }

                        // Commit the transaction
                        connection.commit((err) => {
                          if (err) {
                            return connection.rollback(() => {
                              connection.release();
                              console.error('Error committing transaction:', err);
                              res.status(500).json({ error: 'Error committing transaction' });
                            });
                          }

                          connection.release();

                          // Send success response
                          res.json({ 
                            message: isUpdate ? 'Rating updated successfully' : 'Rating submitted successfully',
                            rating: ratingValue,
                            property_rating: {
                              average: parseFloat(stats.average_rating).toFixed(2),
                              total_count: stats.total_ratings
                            },
                            is_update: isUpdate
                          });
                        });
                      }
                    );
                  }
                );
              }
            }
          );
        }
      );
    });
  });
});

/**
 * GET /api/user-interactions/rating/:id
 * Get user's rating for a specific property
 */
router.get('/rating/:id', auth, (req, res) => {
  const user_id = req.user.id;
  const property_id = req.params.id;

  if (!property_id || isNaN(property_id)) {
    return res.status(400).json({ error: 'Valid Property ID is required' });
  }

  db.query(
    'SELECT rating, updated_at FROM user_property_interactions WHERE user_id = ? AND property_id = ?',
    [user_id, property_id],
    (err, results) => {
      if (err) {
        console.error('Error querying rating:', err);
        return res.status(500).json({ error: 'Error querying rating' });
      }
      
      if (results.length > 0 && results[0].rating !== null) {
        return res.json({ 
          rating: results[0].rating,
          updated_at: results[0].updated_at
        });
      }
      
      return res.json({ rating: null });
    }
  );
});

/**
 * POST /api/user-interactions/favourite
 * Add or remove a property from favorites
 */
router.post('/favourite', auth, (req, res) => {
  const { property_id, isFavourite } = req.body;
  const user_id = req.user.id;

  // Input validation
  if (!property_id || isNaN(property_id)) {
    return res.status(400).json({ error: 'Valid Property ID is required' });
  }

  if (typeof isFavourite !== 'boolean') {
    return res.status(400).json({ error: 'isFavourite must be a boolean value' });
  }

  // Verify property exists
  db.query(
    'SELECT id FROM all_properties WHERE id = ? AND is_active = 1',
    [property_id],
    (err, propertyResults) => {
      if (err) {
        console.error('Error verifying property:', err);
        return res.status(500).json({ error: 'Error verifying property' });
      }

      if (propertyResults.length === 0) {
        return res.status(404).json({ error: 'Property not found or inactive' });
      }

      // Check if interaction record already exists
      db.query(
        'SELECT * FROM user_property_interactions WHERE user_id = ? AND property_id = ?',
        [user_id, property_id],
        (err, existingResults) => {
          if (err) {
            console.error('Error checking existing interaction:', err);
            return res.status(500).json({ error: 'Error checking existing interaction' });
          }

          if (existingResults.length > 0) {
            // Update existing record
            db.query(
              'UPDATE user_property_interactions SET isFavourite = ?, updated_at = NOW() WHERE user_id = ? AND property_id = ?',
              [isFavourite ? 1 : 0, user_id, property_id],
              (err) => {
                if (err) {
                  console.error('Error updating favourite status:', err);
                  return res.status(500).json({ error: 'Error updating favourite status' });
                }

                res.json({ 
                  message: isFavourite ? 'Added to favourites' : 'Removed from favourites',
                  isFavourite: isFavourite
                });
              }
            );
          } else {
            // Insert new record
            db.query(
              'INSERT INTO user_property_interactions (user_id, property_id, isFavourite, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
              [user_id, property_id, isFavourite ? 1 : 0],
              (err) => {
                if (err) {
                  console.error('Error inserting favourite status:', err);
                  return res.status(500).json({ error: 'Error inserting favourite status' });
                }

                res.json({ 
                  message: isFavourite ? 'Added to favourites' : 'Removed from favourites',
                  isFavourite: isFavourite
                });
              }
            );
          }
        }
      );
    }
  );
});

/**
 * GET /api/user-interactions/favourite-status/:id
 * Check if a property is in user's favourites
 */
router.get('/favourite-status/:id', auth, (req, res) => {
  const user_id = req.user.id;
  const property_id = req.params.id;

  if (!property_id || isNaN(property_id)) {
    return res.status(400).json({ error: 'Valid Property ID is required' });
  }

  db.query(
    'SELECT isFavourite FROM user_property_interactions WHERE user_id = ? AND property_id = ?',
    [user_id, property_id],
    (err, results) => {
      if (err) {
        console.error('Error checking favourite status:', err);
        return res.status(500).json({ error: 'Error checking favourite status' });
      }
      
      if (results.length > 0 && results[0].isFavourite !== null) {
        return res.json({ 
          isFavourite: Boolean(results[0].isFavourite)
        });
      }
      
      return res.json({ isFavourite: false });
    }
  );
});

/**
 * GET /api/user-interactions/favourites
 * Get all favourite properties for the current user
 */
router.get('/favourites', auth, (req, res) => {
  const user_id = req.user.id;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;

  // Get favourite properties with property details
  // Fixed query: Join with user_profiles table to get owner information
  const query = `
    SELECT 
      p.*,
      CONCAT(up.first_name, ' ', up.last_name) as owner_name,
      up.phone as owner_phone,
      u.email as owner_email,
      ui.updated_at as favourited_at
    FROM user_property_interactions ui
    JOIN all_properties p ON ui.property_id = p.id
    JOIN users u ON p.user_id = u.id
    LEFT JOIN user_profiles up ON u.id = up.user_id
    WHERE ui.user_id = ? 
      AND ui.isFavourite = 1 
      AND p.is_active = 1
    ORDER BY ui.updated_at DESC
    LIMIT ? OFFSET ?
  `;

  db.query(query, [user_id, limit, offset], (err, results) => {
    if (err) {
      console.error('Error fetching favourite properties:', err);
      return res.status(500).json({ error: 'Error fetching favourite properties' });
    }

    // Get total count for pagination
    db.query(
      `SELECT COUNT(*) as total 
       FROM user_property_interactions ui
       JOIN all_properties p ON ui.property_id = p.id
       WHERE ui.user_id = ? AND ui.isFavourite = 1 AND p.is_active = 1`,
      [user_id],
      (err, countResults) => {
        if (err) {
          console.error('Error counting favourite properties:', err);
          return res.status(500).json({ error: 'Error counting favourite properties' });
        }

        const totalCount = countResults[0].total;
        const totalPages = Math.ceil(totalCount / limit);

        // Process results to ensure proper JSON parsing
        const processedResults = results.map(property => ({
          ...property,
          // Clean up the owner_name field (remove extra spaces)
          owner_name: property.owner_name ? property.owner_name.trim().replace(/\s+/g, ' ') : '',
          images: safeJsonParse(property.images) || [],
          facilities: safeJsonParse(property.facilities) || {},
          amenities: safeJsonParse(property.amenities) || [],
          other_facility: safeJsonParse(property.other_facility) || {},
          rating: parseFloat(property.rating) || 0,
          total_ratings: parseInt(property.total_ratings) || 0
        }));

        res.json({
          properties: processedResults,
          pagination: {
            current_page: page,
            total_pages: totalPages,
            total_count: totalCount,
            has_next: page < totalPages,
            has_prev: page > 1
          }
        });
      }
    );
  });
});

/**
 * POST /api/user-interactions/complaint
 * Submit a complaint about a property
 */
router.post('/complaint', auth, (req, res) => {
  const { property_id, complaint } = req.body;
  const user_id = req.user.id;

  // Input validation
  if (!property_id || isNaN(property_id)) {
    return res.status(400).json({ error: 'Valid Property ID is required' });
  }

  if (!complaint || typeof complaint !== 'string') {
    return res.status(400).json({ error: 'Complaint text is required' });
  }

  const trimmedComplaint = complaint.trim();
  if (trimmedComplaint.length < 10) {
    return res.status(400).json({ error: 'Complaint must be at least 10 characters long' });
  }

  if (trimmedComplaint.length > 1000) {
    return res.status(400).json({ error: 'Complaint must not exceed 1000 characters' });
  }

  // Verify property exists
  db.query(
    'SELECT id FROM all_properties WHERE id = ? AND is_active = 1',
    [property_id],
    (err, propertyResults) => {
      if (err) {
        console.error('Error verifying property:', err);
        return res.status(500).json({ error: 'Error verifying property' });
      }

      if (propertyResults.length === 0) {
        return res.status(404).json({ error: 'Property not found or inactive' });
      }

      // Check if interaction record already exists
      db.query(
        'SELECT * FROM user_property_interactions WHERE user_id = ? AND property_id = ?',
        [user_id, property_id],
        (err, existingResults) => {
          if (err) {
            console.error('Error checking existing interaction:', err);
            return res.status(500).json({ error: 'Error checking existing interaction' });
          }

          if (existingResults.length > 0) {
            // Update existing record
            db.query(
              'UPDATE user_property_interactions SET complaint = ?, complaint_resolved = 0, updated_at = NOW() WHERE user_id = ? AND property_id = ?',
              [trimmedComplaint, user_id, property_id],
              (err) => {
                if (err) {
                  console.error('Error updating complaint:', err);
                  return res.status(500).json({ error: 'Error updating complaint' });
                }

                res.json({ 
                  message: 'Complaint submitted successfully',
                  complaint: trimmedComplaint
                });
              }
            );
          } else {
            // Insert new record
            db.query(
              'INSERT INTO user_property_interactions (user_id, property_id, complaint, complaint_resolved, created_at, updated_at) VALUES (?, ?, ?, 0, NOW(), NOW())',
              [user_id, property_id, trimmedComplaint],
              (err) => {
                if (err) {
                  console.error('Error inserting complaint:', err);
                  return res.status(500).json({ error: 'Error inserting complaint' });
                }

                res.json({ 
                  message: 'Complaint submitted successfully',
                  complaint: trimmedComplaint
                });
              }
            );
          }
        }
      );
    }
  );
});

/**
 * Helper function to safely parse JSON strings
 */
function safeJsonParse(jsonString) {
  if (!jsonString) return null;
  
  // If already an object, return as-is
  if (typeof jsonString === 'object') return jsonString;
  
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    console.warn('Invalid JSON string encountered:', { 
      input: jsonString.substring(0, 100), 
      error: error.message 
    });
    return null;
  }
}

module.exports = router;