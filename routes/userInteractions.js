const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { auth, optionalAuth } = require('../middleware/auth');

const safeJsonParse = (str) => {
  try {
    return JSON.parse(str);
  } catch (error) {
    return [];
  }
};

/**
 * POST /api/user-interactions/view
 * Record a property view (public endpoint for analytics)
 */
router.post('/view', optionalAuth, async (req, res) => {
  const { property_id, view_duration } = req.body;
  const user_id = req.user ? req.user.id : null;

  if (!property_id || isNaN(property_id)) {
    return res.status(400).json({ 
      error: 'Valid Property ID is required' 
    });
  }

  try {
    // Check if property exists and is active
    const propertyExists = await query(
      'SELECT id, views_count FROM all_properties WHERE id = ? AND is_active = 1',
      [property_id]
    );

    if (propertyExists.length === 0) {
      return res.status(404).json({ 
        error: 'Property not found or not active' 
      });
    }

    // Record view in user_interactions if user is logged in
    if (user_id) {
      try {
        await query(
          'INSERT INTO user_interactions (user_id, property_id, interaction_type, view_duration, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())',
          [user_id, property_id, 'view', view_duration || null]
        );
      } catch (insertError) {
        console.error('Error inserting user interaction:', insertError);
        // Continue even if user interaction insert fails
      }
    }

    // Increment property views count
    try {
      await query(
        'UPDATE all_properties SET views_count = COALESCE(views_count, 0) + 1 WHERE id = ?',
        [property_id]
      );
    } catch (updateError) {
      console.error('Error updating views count:', updateError);
      // Continue even if view count update fails
    }

    res.json({
      message: 'Property view recorded successfully',
      property_id: parseInt(property_id)
    });

  } catch (error) {
    console.error('Error recording property view:', error);
    res.status(500).json({ 
      error: 'Database error',
      message: 'Unable to record property view. Please try again.'
    });
  }
});

/**
 * POST /api/user-interactions/favorite
 * Toggle favorite status for a property (optimized version)
 */
router.post('/favorite', auth, async (req, res) => {
  const { property_id } = req.body;
  const user_id = req.user.id;

  // Validate input
  if (!property_id || isNaN(property_id)) {
    return res.status(400).json({ 
      error: 'Valid Property ID is required' 
    });
  }

  try {
    // Check if property exists and is active in one query
    const propertyCheck = await query(
      `SELECT 
        ap.id,
        ap.property_type,
        ap.unit_type,
        ap.is_active,
        ap.approval_status,
        ui.id as favorite_id
      FROM all_properties ap
      LEFT JOIN user_interactions ui ON (ap.id = ui.property_id AND ui.user_id = ? AND ui.interaction_type = ?)
      WHERE ap.id = ?`,
      [user_id, 'favorite', property_id]
    );

    if (propertyCheck.length === 0) {
      return res.status(404).json({ 
        error: 'Property not found'
      });
    }

    const property = propertyCheck[0];

    // Check if property is active and approved
    if (property.is_active !== 1 || property.approval_status !== 'approved') {
      return res.status(400).json({ 
        error: 'Property is not available for favoriting'
      });
    }

    const existingFavorite = property.favorite_id;

    if (existingFavorite) {
      // Remove from favorites
      await query(
        'DELETE FROM user_interactions WHERE id = ?',
        [existingFavorite]
      );

      res.json({
        message: 'Property removed from favorites successfully',
        action: 'removed',
        property_id: parseInt(property_id),
        property_info: {
          type: property.property_type,
          unit_type: property.unit_type
        }
      });
    } else {
      // Add to favorites
      await query(
        `INSERT INTO user_interactions 
         (user_id, property_id, interaction_type, created_at, updated_at) 
         VALUES (?, ?, ?, NOW(), NOW())`,
        [user_id, property_id, 'favorite']
      );

      res.json({
        message: 'Property added to favorites successfully',
        action: 'added',
        property_id: parseInt(property_id),
        property_info: {
          type: property.property_type,
          unit_type: property.unit_type
        }
      });
    }

  } catch (error) {
    console.error('Error managing favorite:', error);
    res.status(500).json({ 
      error: 'Database error',
      message: 'Unable to manage favorite status. Please try again.'
    });
  }
});

/**
 * GET /api/user-interactions/favorite/:property_id
 * Check if property is favorited by current user (optimized)
 */
router.get('/favorite/:property_id', auth, async (req, res) => {
  const property_id = req.params.property_id;
  const user_id = req.user.id;

  if (!property_id || isNaN(property_id)) {
    return res.status(400).json({ 
      error: 'Valid Property ID is required' 
    });
  }

  try {
    const favoriteCheck = await query(
      `SELECT ui.id as favorite_id, ap.property_type, ap.unit_type
       FROM all_properties ap
       LEFT JOIN user_interactions ui ON (ap.id = ui.property_id AND ui.user_id = ? AND ui.interaction_type = ?)
       WHERE ap.id = ?`,
      [user_id, 'favorite', property_id]
    );

    if (favoriteCheck.length === 0) {
      return res.status(404).json({ 
        error: 'Property not found' 
      });
    }

    const result = favoriteCheck[0];
    const isFavorited = result.favorite_id !== null;

    res.json({
      is_favorited: isFavorited,
      property_id: parseInt(property_id),
      property_info: {
        type: result.property_type,
        unit_type: result.unit_type
      }
    });

  } catch (error) {
    console.error('Error checking favorite status:', error);
    res.status(500).json({ 
      error: 'Database error',
      message: 'Unable to check favorite status. Please try again.'
    });
  }
});

/**
 * POST /api/user-interactions/rating
 * Submit or update a property rating
 */
router.post('/rating', auth, async (req, res) => {
  const { property_id, rating_score, rating_comment } = req.body;
  const user_id = req.user.id;

  if (!property_id || isNaN(property_id)) {
    return res.status(400).json({ 
      error: 'Valid Property ID is required' 
    });
  }

  if (!rating_score || isNaN(rating_score)) {
    return res.status(400).json({ 
      error: 'Rating score is required and must be a number' 
    });
  }

  const ratingValue = parseInt(rating_score);
  if (ratingValue < 1 || ratingValue > 5) {
    return res.status(400).json({ 
      error: 'Rating must be an integer between 1 and 5' 
    });
  }

  try {
    // Check if property exists and is available for rating
    const propertyExists = await query(
      'SELECT id, user_id, is_active, approval_status FROM all_properties WHERE id = ?',
      [property_id]
    );

    if (propertyExists.length === 0) {
      return res.status(404).json({ 
        error: 'Property not found' 
      });
    }

    const property = propertyExists[0];

    if (!property.is_active || property.approval_status !== 'approved') {
      return res.status(400).json({ 
        error: 'Property is not available for rating' 
      });
    }

    if (property.user_id === user_id) {
      return res.status(400).json({ 
        error: 'Property owners cannot rate their own properties' 
      });
    }

    // Check if user has already rated this property
    const existingRating = await query(
      'SELECT id FROM user_interactions WHERE user_id = ? AND property_id = ? AND interaction_type = ?',
      [user_id, property_id, 'rating']
    );

    if (existingRating.length > 0) {
      // Update existing rating
      await query(
        'UPDATE user_interactions SET rating_score = ?, rating_comment = ?, updated_at = NOW() WHERE user_id = ? AND property_id = ? AND interaction_type = ?',
        [ratingValue, rating_comment || null, user_id, property_id, 'rating']
      );

      res.json({
        message: 'Rating updated successfully',
        action: 'updated',
        rating: ratingValue,
        property_id: parseInt(property_id)
      });
    } else {
      // Create new rating
      await query(
        'INSERT INTO user_interactions (user_id, property_id, interaction_type, rating_score, rating_comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NOW(), NOW())',
        [user_id, property_id, 'rating', ratingValue, rating_comment || null]
      );

      res.json({
        message: 'Rating submitted successfully',
        action: 'created',
        rating: ratingValue,
        property_id: parseInt(property_id)
      });
    }

  } catch (error) {
    console.error('Error submitting rating:', error);
    res.status(500).json({ 
      error: 'Database error',
      message: 'Unable to submit rating. Please try again.'
    });
  }
});

/**
 * GET /api/user-interactions/rating/:property_id
 * Get user's rating for a specific property
 */
router.get('/rating/:property_id', auth, async (req, res) => {
  const property_id = req.params.property_id;
  const user_id = req.user.id;

  if (!property_id || isNaN(property_id)) {
    return res.status(400).json({ 
      error: 'Valid Property ID is required' 
    });
  }

  try {
    const userRating = await query(
      'SELECT rating_score, rating_comment, created_at, updated_at FROM user_interactions WHERE user_id = ? AND property_id = ? AND interaction_type = ?',
      [user_id, property_id, 'rating']
    );

    if (userRating.length === 0) {
      return res.json({
        has_rated: false,
        property_id: parseInt(property_id)
      });
    }

    res.json({
      has_rated: true,
      rating: userRating[0],
      property_id: parseInt(property_id)
    });

  } catch (error) {
    console.error('Error fetching user rating:', error);
    res.status(500).json({ 
      error: 'Database error',
      message: 'Unable to fetch rating. Please try again.'
    });
  }
});

/**
 * GET /api/user-interactions/property-rating/:property_id
 * Get overall rating information for a property (public endpoint)
 */
router.get('/property-rating/:property_id', optionalAuth, async (req, res) => {
  const property_id = req.params.property_id;

  if (!property_id || isNaN(property_id)) {
    return res.status(400).json({ 
      error: 'Valid Property ID is required' 
    });
  }

  try {
    // Get overall rating statistics
    const overallStats = await query(
      `SELECT 
        COUNT(*) as total_ratings,
        COALESCE(AVG(rating_score), 0) as average_rating
       FROM user_interactions 
       WHERE property_id = ? AND interaction_type = 'rating' AND rating_score IS NOT NULL`,
      [property_id]
    );

    // Get rating distribution
    const ratingDistribution = await query(
      `SELECT 
        rating_score,
        COUNT(*) as score_count
       FROM user_interactions 
       WHERE property_id = ? AND interaction_type = 'rating' AND rating_score IS NOT NULL
       GROUP BY rating_score
       ORDER BY rating_score DESC`,
      [property_id]
    );

    // Get recent ratings with usernames
    const recentRatings = await query(
      `SELECT 
        ui.rating_score, ui.rating_comment, ui.created_at,
        u.username as reviewer_username
       FROM user_interactions ui
       INNER JOIN users u ON ui.user_id = u.id
       WHERE ui.property_id = ? AND ui.interaction_type = 'rating' AND ui.rating_score IS NOT NULL
       ORDER BY ui.created_at DESC
       LIMIT 5`,
      [property_id]
    );

    const totalRatings = overallStats[0]?.total_ratings || 0;
    const rawAverageRating = overallStats[0]?.average_rating || 0;
    
    // Safely handle averageRating conversion
    const averageRating = rawAverageRating && !isNaN(rawAverageRating) ? parseFloat(rawAverageRating) : 0;

    const response = {
      property_id: parseInt(property_id),
      total_ratings: parseInt(totalRatings),
      average_rating: parseFloat(averageRating.toFixed(2)),
      rating_distribution: {},
      recent_ratings: recentRatings || []
    };

    // Process rating distribution
    if (ratingDistribution && ratingDistribution.length > 0) {
      ratingDistribution.forEach(stat => {
        response.rating_distribution[stat.rating_score] = stat.score_count;
      });
    }

    // Add user's rating if authenticated
    if (req.user) {
      try {
        const userRating = await query(
          'SELECT rating_score, rating_comment FROM user_interactions WHERE user_id = ? AND property_id = ? AND interaction_type = ?',
          [req.user.id, property_id, 'rating']
        );
        
        response.user_rating = userRating.length > 0 ? userRating[0] : null;
        response.has_rated = userRating.length > 0;
      } catch (userRatingError) {
        console.error('Error fetching user rating:', userRatingError);
        response.user_rating = null;
        response.has_rated = false;
      }
    }

    res.json(response);

  } catch (error) {
    console.error('Error fetching property rating:', error);
    res.status(500).json({ 
      error: 'Database error',
      message: 'Unable to fetch property rating. Please try again.'
    });
  }
});

/**
 * GET /api/user-interactions/statistics/:property_id
 * Get property statistics - allow public access for basic stats
 */
router.get('/statistics/:property_id', optionalAuth, async (req, res) => {
  const property_id = req.params.property_id;
  const user_id = req.user ? req.user.id : null;
  const user_role = req.user ? req.user.role : null;

  if (!property_id || isNaN(property_id)) {
    return res.status(400).json({ 
      error: 'Valid Property ID is required' 
    });
  }

  try {
    // Check if property exists
    const propertyExists = await query(
      'SELECT id, user_id, views_count FROM all_properties WHERE id = ?',
      [property_id]
    );

    if (propertyExists.length === 0) {
      return res.status(404).json({ 
        error: 'Property not found' 
      });
    }

    const property = propertyExists[0];

    // For detailed statistics, require ownership or admin role
    const canViewDetailedStats = user_id && (user_role === 'admin' || property.user_id === user_id);

    if (canViewDetailedStats) {
      // Return detailed statistics for owners/admins
      const statsQuery = `
        SELECT 
          interaction_type,
          COUNT(*) as count,
          AVG(CASE WHEN interaction_type = 'rating' THEN rating_score END) as avg_rating
        FROM user_interactions 
        WHERE property_id = ?
        GROUP BY interaction_type
      `;

      const stats = await query(statsQuery, [property_id]);

      const processedStats = {
        property_id: parseInt(property_id),
        total_views: property.views_count || 0,
        total_favorites: 0,
        total_ratings: 0,
        total_complaints: 0,
        total_tracked_views: 0,
        average_rating: 0,
        complaint_status_breakdown: {},
        rating_distribution: {}
      };

      if (stats && stats.length > 0) {
        stats.forEach(stat => {
          if (stat.interaction_type === 'favorite') {
            processedStats.total_favorites = stat.count;
          } else if (stat.interaction_type === 'rating') {
            processedStats.total_ratings = stat.count;
            // Safely handle avg_rating conversion
            const rawAvgRating = stat.avg_rating;
            if (rawAvgRating && !isNaN(rawAvgRating)) {
              const avgRating = parseFloat(rawAvgRating);
              processedStats.average_rating = parseFloat(avgRating.toFixed(2));
            } else {
              processedStats.average_rating = 0;
            }
          } else if (stat.interaction_type === 'complaint') {
            processedStats.total_complaints = stat.count;
          } else if (stat.interaction_type === 'view') {
            processedStats.total_tracked_views = stat.count;
          }
        });
      }

      res.json(processedStats);
    } else {
      // Return basic public statistics
      const publicStats = await query(
        `SELECT 
          COUNT(CASE WHEN interaction_type = 'rating' THEN 1 END) as total_ratings,
          COALESCE(AVG(CASE WHEN interaction_type = 'rating' THEN rating_score END), 0) as average_rating,
          COUNT(CASE WHEN interaction_type = 'favorite' THEN 1 END) as total_favorites
         FROM user_interactions 
         WHERE property_id = ?`,
        [property_id]
      );

      const stats = publicStats[0] || {};
      
      // Safely handle average_rating conversion
      const rawAvgRating = stats.average_rating || 0;
      const avgRating = rawAvgRating && !isNaN(rawAvgRating) ? parseFloat(rawAvgRating) : 0;

      res.json({
        property_id: parseInt(property_id),
        total_views: property.views_count || 0,
        total_ratings: stats.total_ratings || 0,
        average_rating: parseFloat(avgRating.toFixed(2)),
        total_favorites: stats.total_favorites || 0
      });
    }

  } catch (error) {
    console.error('Error fetching property statistics:', error);
    res.status(500).json({ 
      error: 'Database error',
      message: 'Unable to fetch property statistics. Please try again.'
    });
  }
});

/**
 * POST /api/user-interactions/complaint
 * Submit a complaint about a property
 */
router.post('/complaint', auth, async (req, res) => {
  const { property_id, category, description } = req.body;
  const user_id = req.user.id;

  console.log('Complaint request body:', req.body);
  console.log('User ID:', user_id);

  if (!property_id || isNaN(property_id)) {
    return res.status(400).json({ 
      error: 'Valid Property ID is required' 
    });
  }

  if (!category) {
    return res.status(400).json({ 
      error: 'Complaint category is required' 
    });
  }

  if (!description || typeof description !== 'string') {
    return res.status(400).json({ 
      error: 'Complaint description is required' 
    });
  }

  if (description.trim().length < 10) {
    return res.status(400).json({ 
      error: 'Complaint description must be at least 10 characters long' 
    });
  }

  const allowedCategories = ['misleading_info', 'property_condition', 'safety_concerns', 'harassment', 'fraud', 'other'];
  if (!allowedCategories.includes(category)) {
    return res.status(400).json({ 
      error: 'Invalid complaint category',
      allowed: allowedCategories,
      received: category
    });
  }

  try {
    // Check if property exists
    const propertyExists = await query(
      'SELECT id, user_id FROM all_properties WHERE id = ?',
      [property_id]
    );

    if (propertyExists.length === 0) {
      return res.status(404).json({ 
        error: 'Property not found' 
      });
    }

    const property = propertyExists[0];

    // Check if user is trying to complain about their own property
    if (property.user_id === user_id) {
      return res.status(400).json({ 
        error: 'You cannot submit a complaint against your own property' 
      });
    }

    // Insert the complaint
    await query(
      `INSERT INTO user_interactions 
       (user_id, property_id, interaction_type, complaint_category, complaint_description, complaint_status, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [user_id, property_id, 'complaint', category, description.trim(), 'pending']
    );

    res.json({
      message: 'Complaint submitted successfully',
      property_id: parseInt(property_id),
      status: 'pending'
    });

  } catch (error) {
    console.error('Error submitting complaint:', error);
    res.status(500).json({ 
      error: 'Database error',
      message: 'Unable to submit complaint. Please try again.'
    });
  }
});

/**
 * GET /api/user-interactions/favorites
 * Get user's favorite properties (MINIMAL FIX - using original working structure)
 */
router.get('/favorites', auth, async (req, res) => {
  const user_id = req.user.id;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  try {
    const countQuery = `
      SELECT COUNT(*) as total 
      FROM user_interactions ui 
      INNER JOIN all_properties ap ON ui.property_id = ap.id 
      WHERE ui.user_id = ? AND ui.interaction_type = ? AND ap.is_active = 1 AND ap.approval_status = ?
    `;
    const countResult = await query(countQuery, [user_id, 'favorite', 'approved']);
    const totalFavorites = countResult[0].total;

    // Use the ORIGINAL working query structure - just add property_id alias
    const favoritesQuery = `
      SELECT 
        ap.id, 
        ap.id as property_id,
        ap.property_type, ap.unit_type, ap.address, ap.price, 
        ap.amenities, ap.facilities, ap.images, ap.description, 
        ap.bedrooms, ap.bathrooms, ap.available_from, ap.available_to,
        ap.views_count, ap.created_at as property_created,
        ui.created_at as favorited_at,
        u.username as owner_username
      FROM user_interactions ui
      INNER JOIN all_properties ap ON ui.property_id = ap.id
      INNER JOIN users u ON ap.user_id = u.id
      WHERE ui.user_id = ? AND ui.interaction_type = ? AND ap.is_active = 1 AND ap.approval_status = ?
      ORDER BY ui.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const favorites = await query(favoritesQuery, [user_id, 'favorite', 'approved', limit, offset]);

    res.json({
      message: 'Favorite properties retrieved successfully',
      favorites: favorites,
      pagination: {
        current_page: page,
        total_pages: Math.ceil(totalFavorites / limit),
        total_items: totalFavorites,
        items_per_page: limit,
        has_next: page < Math.ceil(totalFavorites / limit),
        has_prev: page > 1
      }
    });

  } catch (error) {
    console.error('Error fetching user favorites:', error);
    res.status(500).json({ 
      error: 'Database error',
      message: 'Unable to fetch favorite properties. Please try again.'
    });
  }
});

/**
 * DELETE /api/user-interactions/rating/:property_id
 * Delete a user's rating for a property
 */
router.delete('/rating/:property_id', auth, async (req, res) => {
  const property_id = req.params.property_id;
  const user_id = req.user.id;

  if (!property_id || isNaN(property_id)) {
    return res.status(400).json({ 
      error: 'Valid Property ID is required' 
    });
  }

  try {
    const existingRating = await query(
      'SELECT id FROM user_interactions WHERE user_id = ? AND property_id = ? AND interaction_type = ?',
      [user_id, property_id, 'rating']
    );

    if (existingRating.length === 0) {
      return res.status(404).json({ 
        error: 'Rating not found',
        message: 'You have not rated this property' 
      });
    }

    await query(
      'DELETE FROM user_interactions WHERE user_id = ? AND property_id = ? AND interaction_type = ?',
      [user_id, property_id, 'rating']
    );

    res.json({
      message: 'Rating deleted successfully',
      property_id: parseInt(property_id)
    });

  } catch (error) {
    console.error('Error deleting rating:', error);
    res.status(500).json({ 
      error: 'Database error',
      message: 'Unable to delete rating. Please try again.'
    });
  }
});

// GET /api/user-interactions/stats
router.get('/stats', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    const [viewStats, ratingStats] = await Promise.all([
      query('SELECT COUNT(*) as totalViews FROM user_interactions WHERE user_id = ? AND interaction_type = "view"', [userId]),
      query('SELECT COUNT(*) as totalRatings FROM user_interactions WHERE user_id = ? AND interaction_type = "rating"', [userId])
    ]);

    res.json({
      totalViews: viewStats[0]?.totalViews || 0,
      totalRatings: ratingStats[0]?.totalRatings || 0
    });
  } catch (error) {
    console.error('Error fetching user interaction stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

module.exports = router;