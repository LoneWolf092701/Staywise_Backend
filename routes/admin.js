const express = require('express');
const router = express.Router();
const { query, executeTransaction } = require('../config/db');
const { auth, requireAdmin } = require('../middleware/auth');

/**
 * Safe JSON parsing function that handles both JSON and comma-separated string formats
 * This ensures admin operations can process property data regardless of storage format
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
 * GET /api/admin/dashboard
 * Get admin dashboard statistics
 */
router.get('/dashboard', auth, requireAdmin, async (req, res) => {
  try {
    // Get overall statistics
    const statsQuery = `
      SELECT 
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM users WHERE role = 'user') as total_regular_users,
        (SELECT COUNT(*) FROM users WHERE role = 'propertyowner') as total_property_owners,
        (SELECT COUNT(*) FROM all_properties) as total_properties,
        (SELECT COUNT(*) FROM all_properties WHERE approval_status = 'pending') as pending_properties,
        (SELECT COUNT(*) FROM all_properties WHERE approval_status = 'approved') as approved_properties,
        (SELECT COUNT(*) FROM all_properties WHERE is_active = 1) as active_properties,
        (SELECT COUNT(*) FROM user_interactions WHERE interaction_type = 'complaint' AND complaint_status = 'pending') as pending_complaints,
        (SELECT COUNT(*) FROM booking_requests WHERE status = 'pending') as pending_bookings
    `;

    const stats = await query(statsQuery);
    const dashboardStats = stats[0];

    // Get recent activities
    const recentPropsQuery = `
      SELECT ap.id, ap.property_type, ap.unit_type, ap.address, ap.created_at, ap.approval_status,
             u.username as owner_username
      FROM all_properties ap
      INNER JOIN users u ON ap.user_id = u.id
      WHERE ap.approval_status = 'pending'
      ORDER BY ap.created_at DESC
      LIMIT 5
    `;

    const recentComplaints = `
      SELECT ui.id, ui.complaint_category, ui.complaint_description, ui.created_at,
             ap.property_type, ap.address, u.username as complainant
      FROM user_interactions ui
      INNER JOIN all_properties ap ON ui.property_id = ap.id
      INNER JOIN users u ON ui.user_id = u.id
      WHERE ui.interaction_type = 'complaint' AND ui.complaint_status = 'pending'
      ORDER BY ui.created_at DESC
      LIMIT 5
    `;

    const recentUsers = `
      SELECT id, username, email, role, created_at, email_verified
      FROM users
      ORDER BY created_at DESC
      LIMIT 5
    `;

    const [pendingProperties, complaints, newUsers] = await Promise.all([
      query(recentPropsQuery),
      query(recentComplaints),
      query(recentUsers)
    ]);

    res.json({
      statistics: dashboardStats,
      recent_activities: {
        pending_properties: pendingProperties,
        pending_complaints: complaints,
        new_users: newUsers
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error fetching admin dashboard:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch dashboard data. Please try again.'
    });
  }
});

/**
 * GET /api/admin/users
 * Get all users with filtering and pagination
 */
router.get('/users', auth, requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;
    const role = req.query.role;
    const search = req.query.search;
    const sort = req.query.sort || 'created_at';
    const order = req.query.order === 'asc' ? 'ASC' : 'DESC';

    let whereClause = '';
    let queryParams = [];

    // Build where clause
    const conditions = [];
    
    if (role && ['user', 'propertyowner', 'admin'].includes(role)) {
      conditions.push('u.role = ?');
      queryParams.push(role);
    }

    if (search) {
      conditions.push('(u.username LIKE ? OR u.email LIKE ?)');
      queryParams.push(`%${search}%`, `%${search}%`);
    }

    if (conditions.length > 0) {
      whereClause = 'WHERE ' + conditions.join(' AND ');
    }

    // Validate sort field
    const allowedSortFields = ['username', 'email', 'role', 'created_at', 'email_verified'];
    const sortField = allowedSortFields.includes(sort) ? sort : 'created_at';

    // Count total users
    const countQuery = `SELECT COUNT(*) as total FROM users u ${whereClause}`;
    const countResult = await query(countQuery, queryParams);
    const totalUsers = countResult[0].total;

    // Get users with profile info
    const usersQuery = `
      SELECT 
        u.id, u.username, u.email, u.role, u.email_verified, u.created_at, u.updated_at,
        up.first_name, up.last_name, up.phone, up.business_name,
        (SELECT COUNT(*) FROM all_properties WHERE user_id = u.id) as property_count,
        (SELECT COUNT(*) FROM booking_requests WHERE user_id = u.id) as booking_count
      FROM users u
      LEFT JOIN user_profiles up ON u.id = up.user_id
      ${whereClause}
      ORDER BY u.${sortField} ${order}
      LIMIT ? OFFSET ?
    `;

    queryParams.push(limit, offset);
    const users = await query(usersQuery, queryParams);

    res.json({
      users: users.map(user => ({
        ...user,
        email_verified: Boolean(user.email_verified),
        property_count: parseInt(user.property_count) || 0,
        booking_count: parseInt(user.booking_count) || 0
      })),
      pagination: {
        page: page,
        limit: limit,
        total: totalUsers,
        totalPages: Math.ceil(totalUsers / limit),
        hasNext: page < Math.ceil(totalUsers / limit),
        hasPrevious: page > 1
      },
      filters: {
        role: role || null,
        search: search || null,
        sort: sortField,
        order: order.toLowerCase()
      }
    });

  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch users. Please try again.'
    });
  }
});

/**
 * GET /api/admin/properties/pending
 * Get properties pending approval
 */
router.get('/properties/pending', auth, requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = (page - 1) * limit;

    const countQuery = `
      SELECT COUNT(*) as total 
      FROM all_properties 
      WHERE approval_status = 'pending'
    `;
    const countResult = await query(countQuery);
    const totalPending = countResult[0].total;

    const propertiesQuery = `
      SELECT 
        ap.*, 
        u.username as owner_username,
        u.email as owner_email,
        up.business_name as owner_business_name,
        up.phone as owner_phone
      FROM all_properties ap
      INNER JOIN users u ON ap.user_id = u.id
      LEFT JOIN user_profiles up ON u.id = up.user_id
      WHERE ap.approval_status = 'pending'
      ORDER BY ap.created_at ASC
      LIMIT ? OFFSET ?
    `;

    const properties = await query(propertiesQuery, [limit, offset]);

    const processedProperties = properties.map(property => ({
      ...property,
      price: parseFloat(property.price),
      amenities: safeJsonParse(property.amenities),
      facilities: safeJsonParse(property.facilities),
      images: safeJsonParse(property.images),
      owner_info: {
        username: property.owner_username,
        email: property.owner_email,
        business_name: property.owner_business_name,
        phone: property.owner_phone
      }
    }));

    // Clean up processed properties
    processedProperties.forEach(property => {
      delete property.owner_username;
      delete property.owner_email;
      delete property.owner_business_name;
      delete property.owner_phone;
    });

    res.json({
      pending_properties: processedProperties,
      pagination: {
        page: page,
        limit: limit,
        total: totalPending,
        totalPages: Math.ceil(totalPending / limit),
        hasNext: page < Math.ceil(totalPending / limit),
        hasPrevious: page > 1
      }
    });

  } catch (error) {
    console.error('Error fetching pending properties:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch pending properties. Please try again.'
    });
  }
});

/**
 * PUT /api/admin/properties/:id/approve
 * Approve a property
 */
router.put('/properties/:id/approve', auth, requireAdmin, async (req, res) => {
  const propertyId = req.params.id;
  const adminId = req.user.id;
  const { approval_reason } = req.body;

  if (!propertyId || isNaN(propertyId)) {
    return res.status(400).json({
      error: 'Invalid property ID',
      message: 'Property ID must be a valid number'
    });
  }

  try {
    // Check if property exists and is pending
    const existingProperty = await query(
      'SELECT id, user_id, property_type, address, approval_status FROM all_properties WHERE id = ?',
      [propertyId]
    );

    if (existingProperty.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'The specified property does not exist'
      });
    }

    const property = existingProperty[0];

    if (property.approval_status !== 'pending') {
      return res.status(400).json({
        error: 'Invalid status',
        message: `Property is already ${property.approval_status}`
      });
    }

    // Update property status using property_details table if it exists, otherwise all_properties
    const queries = [
      {
        sql: 'UPDATE all_properties SET approval_status = ?, is_active = 1, updated_at = NOW() WHERE id = ?',
        params: ['approved', propertyId]
      }
    ];

    // Check if property_details entry exists and update it too
    const propertyDetailsExists = await query(
      'SELECT id FROM property_details WHERE user_id = ?',
      [property.user_id]
    );

    if (propertyDetailsExists.length > 0) {
      queries.push({
        sql: 'UPDATE property_details SET approval_status = ?, approval_reason = ?, approved_by = ?, approved_at = NOW(), updated_at = NOW() WHERE user_id = ?',
        params: ['approved', approval_reason || 'Property meets all requirements', adminId, property.user_id]
      });
    }

    await executeTransaction(queries);

    res.json({
      message: 'Property approved successfully',
      property_id: parseInt(propertyId),
      property_info: {
        type: property.property_type,
        address: property.address
      },
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

/**
 * PUT /api/admin/properties/:id/reject
 * Reject a property
 */
router.put('/properties/:id/reject', auth, requireAdmin, async (req, res) => {
  const propertyId = req.params.id;
  const adminId = req.user.id;
  const { rejection_reason } = req.body;

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
      'SELECT id, user_id, property_type, address, approval_status FROM all_properties WHERE id = ?',
      [propertyId]
    );

    if (existingProperty.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'The specified property does not exist'
      });
    }

    const property = existingProperty[0];

    if (property.approval_status !== 'pending') {
      return res.status(400).json({
        error: 'Invalid status',
        message: `Property is already ${property.approval_status}`
      });
    }

    const queries = [
      {
        sql: 'UPDATE all_properties SET approval_status = ?, is_active = 0, updated_at = NOW() WHERE id = ?',
        params: ['rejected', propertyId]
      }
    ];

    // Update property_details if exists
    const propertyDetailsExists = await query(
      'SELECT id FROM property_details WHERE user_id = ?',
      [property.user_id]
    );

    if (propertyDetailsExists.length > 0) {
      queries.push({
        sql: 'UPDATE property_details SET approval_status = ?, rejected_reason = ?, approved_by = ?, updated_at = NOW() WHERE user_id = ?',
        params: ['rejected', rejection_reason, adminId, property.user_id]
      });
    }

    await executeTransaction(queries);

    res.json({
      message: 'Property rejected',
      property_id: parseInt(propertyId),
      property_info: {
        type: property.property_type,
        address: property.address
      },
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

/**
 * GET /api/admin/complaints
 * Get all complaints with filtering
 */
router.get('/complaints', auth, requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = (page - 1) * limit;
    const status = req.query.status; // 'pending', 'reviewed', 'resolved'
    const category = req.query.category;

    let whereClause = "WHERE ui.interaction_type = 'complaint'";
    let queryParams = [];

    if (status && ['pending', 'reviewed', 'resolved'].includes(status)) {
      whereClause += ' AND ui.complaint_status = ?';
      queryParams.push(status);
    }

    if (category) {
      whereClause += ' AND ui.complaint_category = ?';
      queryParams.push(category);
    }

    const countQuery = `
      SELECT COUNT(*) as total 
      FROM user_interactions ui 
      ${whereClause}
    `;
    const countResult = await query(countQuery, queryParams);
    const totalComplaints = countResult[0].total;

    const complaintsQuery = `
      SELECT 
        ui.id as complaint_id, ui.complaint_category, ui.complaint_description, 
        ui.complaint_status, ui.created_at as submitted_at, ui.updated_at as status_updated,
        ui.property_id, ap.property_type, ap.unit_type, ap.address,
        complainant.username as complainant_username,
        complainant.email as complainant_email,
        owner.username as property_owner_username,
        owner.email as property_owner_email
      FROM user_interactions ui
      INNER JOIN all_properties ap ON ui.property_id = ap.id
      INNER JOIN users complainant ON ui.user_id = complainant.id
      INNER JOIN users owner ON ap.user_id = owner.id
      ${whereClause}
      ORDER BY ui.created_at DESC
      LIMIT ? OFFSET ?
    `;

    queryParams.push(limit, offset);
    const complaints = await query(complaintsQuery, queryParams);

    res.json({
      complaints: complaints,
      pagination: {
        page: page,
        limit: limit,
        total: totalComplaints,
        totalPages: Math.ceil(totalComplaints / limit),
        hasNext: page < Math.ceil(totalComplaints / limit),
        hasPrevious: page > 1
      },
      filters: {
        status: status || null,
        category: category || null
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
 * PUT /api/admin/complaints/:id/status
 * Update complaint status
 */
router.put('/complaints/:id/status', auth, requireAdmin, async (req, res) => {
  const complaintId = req.params.id;
  const { status, admin_notes } = req.body;

  if (!complaintId || isNaN(complaintId)) {
    return res.status(400).json({
      error: 'Invalid complaint ID',
      message: 'Complaint ID must be a valid number'
    });
  }

  const allowedStatuses = ['pending', 'reviewed', 'resolved'];
  if (!status || !allowedStatuses.includes(status)) {
    return res.status(400).json({
      error: 'Invalid status',
      message: `Status must be one of: ${allowedStatuses.join(', ')}`
    });
  }

  try {
    const existingComplaint = await query(
      'SELECT id, complaint_status, property_id FROM user_interactions WHERE id = ? AND interaction_type = ?',
      [complaintId, 'complaint']
    );

    if (existingComplaint.length === 0) {
      return res.status(404).json({
        error: 'Complaint not found',
        message: 'The specified complaint does not exist'
      });
    }

    const complaint = existingComplaint[0];

    await query(
      'UPDATE user_interactions SET complaint_status = ?, updated_at = NOW() WHERE id = ?',
      [status, complaintId]
    );

    res.json({
      message: 'Complaint status updated successfully',
      complaint_id: parseInt(complaintId),
      old_status: complaint.complaint_status,
      new_status: status,
      admin_notes: admin_notes || null,
      updated_by: req.user.username,
      updated_at: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error updating complaint status:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to update complaint status. Please try again.'
    });
  }
});

/**
 * GET /api/admin/bookings
 * Get all booking requests with filtering
 */
router.get('/bookings', auth, requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = (page - 1) * limit;
    const status = req.query.status;

    let whereClause = '';
    let queryParams = [];

    if (status && ['pending', 'approved', 'rejected', 'cancelled'].includes(status)) {
      whereClause = 'WHERE br.status = ?';
      queryParams.push(status);
    }

    const countQuery = `SELECT COUNT(*) as total FROM booking_requests br ${whereClause}`;
    const countResult = await query(countQuery, queryParams);
    const totalBookings = countResult[0].total;

    const bookingsQuery = `
      SELECT 
        br.*, 
        ap.property_type, ap.unit_type, ap.address as property_address,
        tenant.username as tenant_username, tenant.email as tenant_email,
        owner.username as owner_username, owner.email as owner_email
      FROM booking_requests br
      INNER JOIN all_properties ap ON br.property_id = ap.id
      INNER JOIN users tenant ON br.user_id = tenant.id
      INNER JOIN users owner ON br.property_owner_id = owner.id
      ${whereClause}
      ORDER BY br.created_at DESC
      LIMIT ? OFFSET ?
    `;

    queryParams.push(limit, offset);
    const bookings = await query(bookingsQuery, queryParams);

    res.json({
      bookings: bookings,
      pagination: {
        page: page,
        limit: limit,
        total: totalBookings,
        totalPages: Math.ceil(totalBookings / limit),
        hasNext: page < Math.ceil(totalBookings / limit),
        hasPrevious: page > 1
      },
      filters: {
        status: status || null
      }
    });

  } catch (error) {
    console.error('Error fetching bookings:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch bookings. Please try again.'
    });
  }
});

/**
 * PUT /api/admin/users/:id/status
 * Update user account status (activate/deactivate)
 */
router.put('/users/:id/status', auth, requireAdmin, async (req, res) => {
  const userId = req.params.id;
  const { action, reason } = req.body; // action: 'activate' or 'deactivate'

  if (!userId || isNaN(userId)) {
    return res.status(400).json({
      error: 'Invalid user ID',
      message: 'User ID must be a valid number'
    });
  }

  if (!action || !['activate', 'deactivate'].includes(action)) {
    return res.status(400).json({
      error: 'Invalid action',
      message: 'Action must be either "activate" or "deactivate"'
    });
  }

  if (parseInt(userId) === req.user.id) {
    return res.status(400).json({
      error: 'Cannot modify own account',
      message: 'You cannot modify your own account status'
    });
  }

  try {
    const existingUser = await query(
      'SELECT id, username, email, role FROM users WHERE id = ?',
      [userId]
    );

    if (existingUser.length === 0) {
      return res.status(404).json({
        error: 'User not found',
        message: 'The specified user does not exist'
      });
    }

    const user = existingUser[0];

    if (user.role === 'admin' && action === 'deactivate') {
      return res.status(400).json({
        error: 'Cannot deactivate admin',
        message: 'Admin accounts cannot be deactivated'
      });
    }

    const newStatus = action === 'activate' ? 1 : 0;
    
    await query(
      'UPDATE users SET email_verified = ?, updated_at = NOW() WHERE id = ?',
      [newStatus, userId]
    );

    res.json({
      message: `User ${action}d successfully`,
      user_id: parseInt(userId),
      user_info: {
        username: user.username,
        email: user.email,
        role: user.role
      },
      action: action,
      reason: reason || null,
      updated_by: req.user.username,
      updated_at: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error updating user status:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to update user status. Please try again.'
    });
  }
});

/**
 * GET /api/admin/analytics
 * Get analytics data for admin dashboard
 */
router.get('/analytics', auth, requireAdmin, async (req, res) => {
  try {
    const period = req.query.period || '30'; // days
    const days = parseInt(period);

    if (isNaN(days) || days < 1 || days > 365) {
      return res.status(400).json({
        error: 'Invalid period',
        message: 'Period must be between 1 and 365 days'
      });
    }

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startDateStr = startDate.toISOString().split('T')[0];

    // User registrations over time
    const userRegistrations = await query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as registrations,
        COUNT(CASE WHEN role = 'user' THEN 1 END) as user_registrations,
        COUNT(CASE WHEN role = 'propertyowner' THEN 1 END) as owner_registrations
      FROM users 
      WHERE created_at >= ?
      GROUP BY DATE(created_at)
      ORDER BY date
    `, [startDateStr]);

    // Property submissions over time
    const propertySubmissions = await query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as submissions,
        COUNT(CASE WHEN approval_status = 'approved' THEN 1 END) as approved,
        COUNT(CASE WHEN approval_status = 'rejected' THEN 1 END) as rejected
      FROM all_properties 
      WHERE created_at >= ?
      GROUP BY DATE(created_at)
      ORDER BY date
    `, [startDateStr]);

    // Top property types
    const topPropertyTypes = await query(`
      SELECT 
        property_type,
        COUNT(*) as count,
        COUNT(CASE WHEN approval_status = 'approved' THEN 1 END) as approved_count
      FROM all_properties 
      WHERE created_at >= ?
      GROUP BY property_type
      ORDER BY count DESC
      LIMIT 10
    `, [startDateStr]);

    // Complaint categories
    const complaintCategories = await query(`
      SELECT 
        complaint_category,
        COUNT(*) as count,
        COUNT(CASE WHEN complaint_status = 'resolved' THEN 1 END) as resolved_count
      FROM user_interactions 
      WHERE interaction_type = 'complaint' AND created_at >= ?
      GROUP BY complaint_category
      ORDER BY count DESC
    `, [startDateStr]);

    res.json({
      period_days: days,
      start_date: startDateStr,
      analytics: {
        user_registrations: userRegistrations,
        property_submissions: propertySubmissions,
        top_property_types: topPropertyTypes,
        complaint_categories: complaintCategories
      },
      generated_at: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch analytics data. Please try again.'
    });
  }
});

module.exports = router;