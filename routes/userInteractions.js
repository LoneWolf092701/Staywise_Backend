const express = require('express');
const router = express.Router();
const { query, getConnection, executeTransaction } = require('../config/db');
const { auth, optionalAuth } = require('../middleware/auth');

/**
 * Safe JSON parsing function that handles both JSON and comma-separated string formats
 * This ensures compatibility with different data storage formats in the database
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
 * POST /api/user-interactions/favorite
 * Add or remove a property from user favorites
 */
router.post('/favorite', auth, async (req, res) => {
  const { property_id } = req.body;
  const user_id = req.user.id;

  if (!property_id || isNaN(property_id)) {
    return res.status(400).json({ 
      error: 'Valid Property ID is required' 
    });
  }

  try {
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
        error: 'Property is not available for interaction' 
      });
    }

    if (property.user_id === user_id) {
      return res.status(400).json({ 
        error: 'Property owners cannot favorite their own properties' 
      });
    }

    const existingFavorite = await query(
      'SELECT id FROM user_interactions WHERE user_id = ? AND property_id = ? AND interaction_type = ?',
      [user_id, property_id, 'favorite']
    );

    if (existingFavorite.length > 0) {
      await query(
        'DELETE FROM user_interactions WHERE user_id = ? AND property_id = ? AND interaction_type = ?',
        [user_id, property_id, 'favorite']
      );

      res.json({
        message: 'Property removed from favorites',
        action: 'removed',
        property_id: parseInt(property_id)
      });
    } else {
      await query(
        'INSERT INTO user_interactions (user_id, property_id, interaction_type, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
        [user_id, property_id, 'favorite']
      );

      res.json({
        message: 'Property added to favorites',
        action: 'added',
        property_id: parseInt(property_id)
      });
    }

  } catch (error) {
    console.error('Error managing favorite:', error);
    res.status(500).json({ 
      error: 'Database error',
      message: 'Unable to manage favorite. Please try again.'
    });
  }
});

/**
 * POST /api/user-interactions/rating
 * Submit or update a property rating
 */
router.post('/rating', auth, async (req, res) => {
  const { property_id, rating, comment } = req.body;
  const user_id = req.user.id;

  if (!property_id || isNaN(property_id)) {
    return res.status(400).json({ 
      error: 'Valid Property ID is required' 
    });
  }

  if (!rating || isNaN(rating)) {
    return res.status(400).json({ 
      error: 'Rating is required and must be a number' 
    });
  }

  const ratingValue = parseInt(rating);
  if (ratingValue < 1 || ratingValue > 5) {
    return res.status(400).json({ 
      error: 'Rating must be an integer between 1 and 5' 
    });
  }

  try {
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

    const existingRating = await query(
      'SELECT id FROM user_interactions WHERE user_id = ? AND property_id = ? AND interaction_type = ?',
      [user_id, property_id, 'rating']
    );

    if (existingRating.length > 0) {
      await query(
        'UPDATE user_interactions SET rating_score = ?, rating_comment = ?, updated_at = NOW() WHERE user_id = ? AND property_id = ? AND interaction_type = ?',
        [ratingValue, comment || null, user_id, property_id, 'rating']
      );

      res.json({
        message: 'Rating updated successfully',
        action: 'updated',
        rating: ratingValue,
        property_id: parseInt(property_id)
      });
    } else {
      await query(
        'INSERT INTO user_interactions (user_id, property_id, interaction_type, rating_score, rating_comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NOW(), NOW())',
        [user_id, property_id, 'rating', ratingValue, comment || null]
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
 * POST /api/user-interactions/complaint
 * Submit a complaint about a property
 */
router.post('/complaint', auth, async (req, res) => {
  const { property_id, category, description } = req.body;
  const user_id = req.user.id;

  if (!property_id || isNaN(property_id)) {
    return res.status(400).json({ 
      error: 'Valid Property ID is required' 
    });
  }

  if (!category || !description) {
    return res.status(400).json({ 
      error: 'Complaint category and description are required' 
    });
  }

  if (description.length < 10) {
    return res.status(400).json({ 
      error: 'Complaint description must be at least 10 characters long' 
    });
  }

  const allowedCategories = ['misleading_info', 'property_condition', 'safety_concerns', 'harassment', 'fraud', 'other'];
  if (!allowedCategories.includes(category)) {
    return res.status(400).json({ 
      error: 'Invalid complaint category',
      allowed: allowedCategories 
    });
  }

  try {
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

    if (property.user_id === user_id) {
      return res.status(400).json({ 
        error: 'Property owners cannot submit complaints about their own properties' 
      });
    }

    const result = await query(
      'INSERT INTO user_interactions (user_id, property_id, interaction_type, complaint_category, complaint_description, complaint_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())',
      [user_id, property_id, 'complaint', category, description, 'pending']
    );

    res.status(201).json({
      message: 'Complaint submitted successfully',
      complaint_id: result.insertId,
      status: 'pending',
      property_id: parseInt(property_id)
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
 * POST /api/user-interactions/view
 * Track property view (for analytics)
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
    const propertyExists = await query(
      'SELECT id, views_count FROM all_properties WHERE id = ? AND is_active = 1 AND approval_status = ?',
      [property_id, 'approved']
    );

    if (propertyExists.length === 0) {
      return res.status(404).json({ 
        error: 'Property not found or not available' 
      });
    }

    const queries = [
      {
        sql: 'UPDATE all_properties SET views_count = views_count + 1, updated_at = NOW() WHERE id = ?',
        params: [property_id]
      }
    ];

    if (user_id) {
      queries.push({
        sql: 'INSERT INTO user_interactions (user_id, property_id, interaction_type, view_duration, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())',
        params: [user_id, property_id, 'view', view_duration || null]
      });
    }

    await executeTransaction(queries);

    res.json({
      message: 'Property view tracked',
      property_id: parseInt(property_id),
      new_views_count: propertyExists[0].views_count + 1
    });

  } catch (error) {
    console.error('Error tracking view:', error);
    res.status(500).json({ 
      error: 'Database error',
      message: 'Unable to track view. Please try again.'
    });
  }
});

/**
 * GET /api/user-interactions/favorites
 * Get user's favorite properties
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

    const favoritesQuery = `
      SELECT 
        ap.id, ap.property_type, ap.unit_type, ap.address, ap.price, 
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

    const processedFavorites = favorites.map(fav => ({
      ...fav,
      amenities: safeJsonParse(fav.amenities),
      facilities: safeJsonParse(fav.facilities),
      images: safeJsonParse(fav.images),
      price: parseFloat(fav.price)
    }));

    res.json({
      favorites: processedFavorites,
      pagination: {
        page: page,
        limit: limit,
        total: totalFavorites,
        totalPages: Math.ceil(totalFavorites / limit),
        hasNext: page < Math.ceil(totalFavorites / limit),
        hasPrevious: page > 1
      }
    });

  } catch (error) {
    console.error('Error fetching favorites:', error);
    res.status(500).json({ 
      error: 'Database error',
      message: 'Unable to fetch favorites. Please try again.'
    });
  }
});

/**
 * GET /api/user-interactions/ratings
 * Get user's property ratings
 */
router.get('/ratings', auth, async (req, res) => {
  const user_id = req.user.id;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  try {
    const countQuery = `
      SELECT COUNT(*) as total 
      FROM user_interactions ui 
      INNER JOIN all_properties ap ON ui.property_id = ap.id 
      WHERE ui.user_id = ? AND ui.interaction_type = ?
    `;
    const countResult = await query(countQuery, [user_id, 'rating']);
    const totalRatings = countResult[0].total;

    const ratingsQuery = `
      SELECT 
        ui.id as interaction_id, ui.rating_score, ui.rating_comment, 
        ui.created_at as rated_at, ui.updated_at as rating_updated,
        ap.id as property_id, ap.property_type, ap.unit_type, ap.address, 
        ap.price, ap.images, ap.description,
        u.username as owner_username
      FROM user_interactions ui
      INNER JOIN all_properties ap ON ui.property_id = ap.id
      INNER JOIN users u ON ap.user_id = u.id
      WHERE ui.user_id = ? AND ui.interaction_type = ?
      ORDER BY ui.updated_at DESC
      LIMIT ? OFFSET ?
    `;

    const ratings = await query(ratingsQuery, [user_id, 'rating', limit, offset]);

    const processedRatings = ratings.map(rating => ({
      ...rating,
      images: safeJsonParse(rating.images),
      price: parseFloat(rating.price)
    }));

    res.json({
      ratings: processedRatings,
      pagination: {
        page: page,
        limit: limit,
        total: totalRatings,
        totalPages: Math.ceil(totalRatings / limit),
        hasNext: page < Math.ceil(totalRatings / limit),
        hasPrevious: page > 1
      }
    });

  } catch (error) {
    console.error('Error fetching ratings:', error);
    res.status(500).json({ 
      error: 'Database error',
      message: 'Unable to fetch ratings. Please try again.'
    });
  }
});

/**
 * GET /api/user-interactions/complaints
 * Get user's submitted complaints
 */
router.get('/complaints', auth, async (req, res) => {
  const user_id = req.user.id;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  try {
    const countQuery = `
      SELECT COUNT(*) as total 
      FROM user_interactions ui 
      WHERE ui.user_id = ? AND ui.interaction_type = ?
    `;
    const countResult = await query(countQuery, [user_id, 'complaint']);
    const totalComplaints = countResult[0].total;

    const complaintsQuery = `
      SELECT 
        ui.id as complaint_id, ui.complaint_category, ui.complaint_description, 
        ui.complaint_status, ui.created_at as submitted_at, ui.updated_at as status_updated,
        ap.id as property_id, ap.property_type, ap.unit_type, ap.address,
        u.username as owner_username
      FROM user_interactions ui
      INNER JOIN all_properties ap ON ui.property_id = ap.id
      INNER JOIN users u ON ap.user_id = u.id
      WHERE ui.user_id = ? AND ui.interaction_type = ?
      ORDER BY ui.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const complaints = await query(complaintsQuery, [user_id, 'complaint', limit, offset]);

    res.json({
      complaints: complaints,
      pagination: {
        page: page,
        limit: limit,
        total: totalComplaints,
        totalPages: Math.ceil(totalComplaints / limit),
        hasNext: page < Math.ceil(totalComplaints / limit),
        hasPrevious: page > 1
      }
    });

  } catch (error) {
    console.error('Error fetching complaints:', error);
    res.status(500).json({ 
      error: 'Database error',
      message: 'Unable to fetch complaints. Please try again.'
    });
  }
});

/**
 * GET /api/user-interactions/property/:id/stats
 * Get interaction statistics for a specific property (for property owners and admins)
 */
router.get('/property/:id/stats', auth, async (req, res) => {
  const property_id = req.params.id;
  const user_id = req.user.id;
  const user_role = req.user.role;

  if (!property_id || isNaN(property_id)) {
    return res.status(400).json({ 
      error: 'Valid Property ID is required' 
    });
  }

  try {
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

    if (user_role !== 'admin' && property.user_id !== user_id) {
      return res.status(403).json({ 
        error: 'Access denied',
        message: 'You can only view statistics for your own properties' 
      });
    }

    const statsQuery = `
      SELECT 
        interaction_type,
        COUNT(*) as count,
        AVG(CASE WHEN interaction_type = 'rating' THEN rating_score END) as avg_rating,
        COUNT(CASE WHEN interaction_type = 'rating' THEN 1 END) as total_ratings,
        COUNT(CASE WHEN interaction_type = 'favorite' THEN 1 END) as total_favorites,
        COUNT(CASE WHEN interaction_type = 'complaint' THEN 1 END) as total_complaints,
        COUNT(CASE WHEN interaction_type = 'view' THEN 1 END) as total_tracked_views
      FROM user_interactions 
      WHERE property_id = ?
      GROUP BY interaction_type
    `;

    const stats = await query(statsQuery, [property_id]);

    const complaintStatusQuery = `
      SELECT complaint_status, COUNT(*) as count
      FROM user_interactions 
      WHERE property_id = ? AND interaction_type = 'complaint'
      GROUP BY complaint_status
    `;

    const complaintStats = await query(complaintStatusQuery, [property_id]);

    const ratingDistributionQuery = `
      SELECT rating_score, COUNT(*) as count
      FROM user_interactions 
      WHERE property_id = ? AND interaction_type = 'rating'
      GROUP BY rating_score
      ORDER BY rating_score
    `;

    const ratingDistribution = await query(ratingDistributionQuery, [property_id]);

    const processedStats = {
      property_id: parseInt(property_id),
      total_views: property.views_count,
      total_favorites: 0,
      total_ratings: 0,
      total_complaints: 0,
      total_tracked_views: 0,
      average_rating: 0,
      complaint_status_breakdown: {},
      rating_distribution: {}
    };

    stats.forEach(stat => {
      if (stat.interaction_type === 'favorite') {
        processedStats.total_favorites = stat.count;
      } else if (stat.interaction_type === 'rating') {
        processedStats.total_ratings = stat.count;
        processedStats.average_rating = stat.avg_rating ? parseFloat(stat.avg_rating.toFixed(2)) : 0;
      } else if (stat.interaction_type === 'complaint') {
        processedStats.total_complaints = stat.count;
      } else if (stat.interaction_type === 'view') {
        processedStats.total_tracked_views = stat.count;
      }
    });

    complaintStats.forEach(stat => {
      processedStats.complaint_status_breakdown[stat.complaint_status] = stat.count;
    });

    ratingDistribution.forEach(rating => {
      processedStats.rating_distribution[rating.rating_score] = rating.count;
    });

    res.json(processedStats);

  } catch (error) {
    console.error('Error fetching property statistics:', error);
    res.status(500).json({ 
      error: 'Database error',
      message: 'Unable to fetch property statistics. Please try again.'
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

module.exports = router;