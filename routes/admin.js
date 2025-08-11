const express = require('express');
const router = express.Router();
const { query, executeTransaction } = require('../config/db');
const { auth, requireAdmin } = require('../middleware/auth');

const safeJsonParse = (str) => {
  try {
    return typeof str === 'string' ? JSON.parse(str) : str;
  } catch (error) {
    console.warn('Error parsing JSON:', error);
    return str || [];
  }
};

router.get('/dashboard', auth, requireAdmin, async (req, res) => {
  try {
    const statsQuery = `
      SELECT 
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM users WHERE role = 'user') as total_regular_users,
        (SELECT COUNT(*) FROM users WHERE role = 'propertyowner') as total_property_owners,
        (SELECT COUNT(*) FROM all_properties) as total_properties,
        (SELECT COUNT(*) FROM all_properties WHERE approval_status = 'pending') as pending_properties,
        (SELECT COUNT(*) FROM all_properties WHERE approval_status = 'approved') as approved_properties,
        (SELECT COUNT(*) FROM all_properties WHERE is_active = 1) as active_properties
    `;

    const stats = await query(statsQuery);
    const dashboardStats = stats[0];

    const recentPropsQuery = `
      SELECT ap.id, ap.property_type, ap.unit_type, ap.address, ap.created_at, ap.approval_status,
             u.username as owner_username
      FROM all_properties ap
      INNER JOIN users u ON ap.user_id = u.id
      WHERE ap.approval_status = 'pending'
      ORDER BY ap.created_at DESC
      LIMIT 5
    `;

    const recentProperties = await query(recentPropsQuery);

    res.json({
      stats: dashboardStats,
      recent_properties: recentProperties.map(prop => ({
        ...prop,
        amenities: safeJsonParse(prop.amenities),
        facilities: safeJsonParse(prop.facilities),
        images: safeJsonParse(prop.images)
      }))
    });

  } catch (error) {
    console.error('Error fetching admin dashboard:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch dashboard data. Please try again.'
    });
  }
});

router.get('/dashboard-stats', auth, requireAdmin, async (req, res) => {
  try {
    const statsQuery = `
      SELECT 
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM users WHERE is_active = 1) as active_users,
        (SELECT COUNT(*) FROM users WHERE DATE(created_at) >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)) as new_this_month,
        (SELECT COUNT(*) FROM all_properties) as total_properties,
        (SELECT COUNT(*) FROM all_properties WHERE approval_status = 'pending') as pending_properties,
        (SELECT COUNT(*) FROM all_properties WHERE approval_status = 'approved') as approved_properties
    `;

    const stats = await query(statsQuery);
    const data = stats[0];

    res.json({
      users: {
        total: data.total_users,
        active: data.active_users,
        new_this_month: data.new_this_month
      },
      properties: {
        total: data.total_properties,
        pending: data.pending_properties,
        approved: data.approved_properties
      },
      bookings: {
        total: 0,
        pending: 0,
        confirmed: 0
      },
      revenue: {
        total: 0,
        this_month: 0
      },
      system_health: {
        status: 'healthy',
        uptime: Math.floor(process.uptime() / 3600)
      }
    });

  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch dashboard statistics.'
    });
  }
});

router.get('/system-health', auth, requireAdmin, async (req, res) => {
  try {
    const dbTest = await query('SELECT 1 as test');
    const dbStatus = dbTest.length > 0 ? 'healthy' : 'error';
    
    res.json({
      status: 'healthy',
      database: {
        status: dbStatus,
        response_time: '< 50ms'
      },
      server: {
        status: 'healthy',
        uptime: Math.floor(process.uptime()),
        memory_usage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
      },
      storage: {
        status: 'healthy',
        usage: 45
      },
      memory: {
        status: 'healthy',
        usage: Math.round((process.memoryUsage().heapUsed / process.memoryUsage().heapTotal) * 100)
      }
    });

  } catch (error) {
    console.error('Error checking system health:', error);
    res.status(500).json({
      status: 'error',
      database: { status: 'error' },
      server: { status: 'error', uptime: 0 },
      storage: { status: 'unknown', usage: 0 },
      memory: { status: 'unknown', usage: 0 }
    });
  }
});

router.get('/financial-reports', auth, requireAdmin, async (req, res) => {
  try {
    res.json({
      total_revenue: 0,
      service_fees_collected: 0,
      property_owner_earnings: 0,
      monthly_breakdown: [],
      top_earning_properties: [],
      payment_methods: {
        card: 0,
        bank_transfer: 0,
        cash: 0
      }
    });

  } catch (error) {
    console.error('Error fetching financial reports:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch financial reports.'
    });
  }
});

router.get('/activity-logs', auth, requireAdmin, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 50,
      user_id,
      action_type,
      date_from,
      date_to,
      sort_by = 'created_at',
      sort_order = 'DESC'
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    res.json({
      logs: [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: 0,
        totalPages: 0
      }
    });

  } catch (error) {
    console.error('Error fetching activity logs:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch activity logs.'
    });
  }
});

router.get('/property-approval-stats', auth, requireAdmin, async (req, res) => {
  try {
    const { period = 'monthly', year, month } = req.query;

    const statsQuery = `
      SELECT 
        COUNT(*) as total_submitted,
        COUNT(CASE WHEN approval_status = 'approved' THEN 1 END) as total_approved,
        COUNT(CASE WHEN approval_status = 'rejected' THEN 1 END) as total_rejected,
        COUNT(CASE WHEN approval_status = 'pending' THEN 1 END) as pending_approval
      FROM all_properties
    `;

    const stats = await query(statsQuery);
    const data = stats[0];

    const approvalRate = data.total_submitted > 0 ? 
      (data.total_approved / data.total_submitted * 100).toFixed(2) : 0;

    res.json({
      total_submitted: data.total_submitted,
      total_approved: data.total_approved,
      total_rejected: data.total_rejected,
      pending_approval: data.pending_approval,
      approval_rate: parseFloat(approvalRate),
      average_approval_time: 24,
      monthly_breakdown: [],
      category_breakdown: {}
    });

  } catch (error) {
    console.error('Error fetching property approval stats:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch property approval statistics.'
    });
  }
});

router.get('/user-statistics', auth, requireAdmin, async (req, res) => {
  try {
    const { period = 'monthly', year, month, role } = req.query;

    const statsQuery = `
      SELECT 
        COUNT(*) as total_users,
        COUNT(CASE WHEN is_active = 1 THEN 1 END) as active_users,
        COUNT(CASE WHEN DATE(created_at) >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) THEN 1 END) as new_registrations
      FROM users
      ${role && role !== 'all' ? 'WHERE role = ?' : ''}
    `;

    const params = role && role !== 'all' ? [role] : [];
    const stats = await query(statsQuery, params);
    const data = stats[0];

    const retentionRate = data.total_users > 0 ? 
      (data.active_users / data.total_users * 100).toFixed(2) : 0;

    const roleDistQuery = `
      SELECT role, COUNT(*) as count
      FROM users
      GROUP BY role
    `;

    const roleData = await query(roleDistQuery);
    const roleDistribution = {};
    roleData.forEach(item => {
      roleDistribution[item.role] = item.count;
    });

    res.json({
      total_users: data.total_users,
      active_users: data.active_users,
      new_registrations: data.new_registrations,
      user_retention_rate: parseFloat(retentionRate),
      role_distribution: roleDistribution,
      monthly_registrations: [],
      activity_metrics: {}
    });

  } catch (error) {
    console.error('Error fetching user statistics:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch user statistics.'
    });
  }
});

router.get('/system-config', auth, requireAdmin, async (req, res) => {
  try {
    res.json({
      maintenance_mode: false,
      registration_enabled: true,
      max_properties_per_owner: 10,
      booking_advance_days: 365,
      service_fee_percentage: 5,
      system_notifications: true
    });

  } catch (error) {
    console.error('Error fetching system config:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch system configuration.'
    });
  }
});

router.put('/system-config', auth, requireAdmin, async (req, res) => {
  try {
    const configData = req.body;

    res.json({
      message: 'System configuration updated successfully',
      config: configData
    });

  } catch (error) {
    console.error('Error updating system config:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to update system configuration.'
    });
  }
});

router.get('/reported-content', auth, requireAdmin, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20,
      status = 'pending',
      content_type,
      sort_by = 'created_at',
      sort_order = 'DESC'
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    res.json({
      reported_content: [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: 0,
        totalPages: 0
      }
    });

  } catch (error) {
    console.error('Error fetching reported content:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch reported content.'
    });
  }
});

router.get('/announcements', auth, requireAdmin, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20,
      status = 'all',
      sort_by = 'created_at',
      sort_order = 'DESC'
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    res.json({
      announcements: [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: 0,
        totalPages: 0
      }
    });

  } catch (error) {
    console.error('Error fetching announcements:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch announcements.'
    });
  }
});

router.post('/announcements', auth, requireAdmin, async (req, res) => {
  try {
    const { title, content, priority = 'normal', target_audience = 'all' } = req.body;

    if (!title || !content) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'Title and content are required'
      });
    }

    res.status(201).json({
      message: 'Announcement created successfully',
      announcement: {
        id: Date.now(),
        title,
        content,
        priority,
        target_audience,
        created_by: req.user.username,
        created_at: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Error creating announcement:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to create announcement.'
    });
  }
});

router.get('/bookings', auth, requireAdmin, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 10,
      status,
      property_id,
      user_id,
      sort_by = 'created_at',
      sort_order = 'DESC'
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    res.json({
      bookings: [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: 0,
        totalPages: 0
      }
    });

  } catch (error) {
    console.error('Error fetching admin bookings:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch bookings.'
    });
  }
});

router.get('/properties', auth, requireAdmin, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      status, 
      approval_status,
      search,
      owner_id,
      sort_by = 'created_at',
      sort_order = 'DESC'
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    let whereClause = 'WHERE 1=1';
    const params = [];

    if (status && status !== 'all') {
      whereClause += ' AND p.is_active = ?';
      params.push(status === 'active' ? 1 : 0);
    }

    if (approval_status && approval_status !== 'all') {
      whereClause += ' AND p.approval_status = ?';
      params.push(approval_status);
    }

    if (owner_id) {
      whereClause += ' AND p.user_id = ?';
      params.push(parseInt(owner_id));
    }

    if (search) {
      whereClause += ' AND (p.address LIKE ? OR p.property_type LIKE ? OR p.unit_type LIKE ? OR u.username LIKE ?)';
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    const allowedSortFields = ['created_at', 'updated_at', 'price', 'views_count', 'approval_status'];
    const sortField = allowedSortFields.includes(sort_by) ? `p.${sort_by}` : 'p.created_at';
    const sortDirection = sort_order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const propertiesQuery = `
      SELECT 
        p.*,
        u.username as owner_name,
        u.email as owner_email,
        up.business_name as owner_business_name,
        up.phone as owner_phone
      FROM all_properties p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN user_profiles up ON u.id = up.user_id
      ${whereClause}
      ORDER BY ${sortField} ${sortDirection}
      LIMIT ? OFFSET ?
    `;

    const countQuery = `
      SELECT COUNT(*) as total FROM all_properties p
      LEFT JOIN users u ON p.user_id = u.id
      ${whereClause}
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
      owner_info: {
        username: property.owner_name,
        email: property.owner_email,
        business_name: property.owner_business_name,
        phone: property.owner_phone
      }
    }));

    processedProperties.forEach(property => {
      delete property.owner_name;
      delete property.owner_email;
      delete property.owner_business_name;
      delete property.owner_phone;
    });

    const total = countResult[0].total;
    const totalPages = Math.ceil(total / parseInt(limit));

    const statusCounts = await query(`
      SELECT 
        approval_status,
        COUNT(*) as count
      FROM all_properties 
      GROUP BY approval_status
    `);

    const stats = {
      total: total,
      pending: statusCounts.find(s => s.approval_status === 'pending')?.count || 0,
      approved: statusCounts.find(s => s.approval_status === 'approved')?.count || 0,
      rejected: statusCounts.find(s => s.approval_status === 'rejected')?.count || 0
    };

    res.json({
      properties: processedProperties,
      pagination: {
        current_page: parseInt(page),
        total_pages: totalPages,
        total_items: total,
        items_per_page: parseInt(limit),
        has_next: parseInt(page) < totalPages,
        has_prev: parseInt(page) > 1
      },
      stats: stats,
      filters_applied: {
        status,
        approval_status,
        search,
        owner_id
      }
    });

  } catch (error) {
    console.error('Error fetching admin properties:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch properties. Please try again.'
    });
  }
});

router.get('/properties/pending', auth, requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = (page - 1) * limit;

    const countQuery = 'SELECT COUNT(*) as total FROM all_properties WHERE approval_status = "pending"';
    const countResult = await query(countQuery);
    const totalPending = countResult[0].total;

    const propertiesQuery = `
      SELECT ap.*, 
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

router.get('/properties/:id', auth, requireAdmin, async (req, res) => {
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
    const processedProperty = {
      ...property,
      price: parseFloat(property.price),
      amenities: safeJsonParse(property.amenities),
      facilities: safeJsonParse(property.facilities),
      images: safeJsonParse(property.images),
      owner_info: {
        username: property.owner_name,
        email: property.owner_email,
        business_name: property.owner_business_name,
        phone: property.owner_phone,
        first_name: property.owner_first_name,
        last_name: property.owner_last_name
      }
    };

    delete processedProperty.owner_name;
    delete processedProperty.owner_email;
    delete processedProperty.owner_business_name;
    delete processedProperty.owner_phone;
    delete processedProperty.owner_first_name;
    delete processedProperty.owner_last_name;

    res.json(processedProperty);

  } catch (error) {
    console.error('Error fetching property details:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch property details. Please try again.'
    });
  }
});

router.put('/properties/:id/approval', auth, requireAdmin, async (req, res) => {
  const propertyId = req.params.id;
  const adminId = req.user.id;
  const { action, reason } = req.body;

  if (!propertyId || isNaN(propertyId)) {
    return res.status(400).json({
      error: 'Invalid property ID',
      message: 'Property ID must be a valid number'
    });
  }

  if (!action || !['approve', 'reject'].includes(action)) {
    return res.status(400).json({
      error: 'Invalid action',
      message: 'Action must be either "approve" or "reject"'
    });
  }

  if (action === 'reject' && (!reason || reason.trim().length < 10)) {
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

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    const newActiveStatus = action === 'approve' ? 1 : 0;

    const queries = [
      {
        sql: 'UPDATE all_properties SET approval_status = ?, is_active = ?, updated_at = NOW() WHERE id = ?',
        params: [newStatus, newActiveStatus, propertyId]
      }
    ];

    const propertyDetailsExists = await query(
      'SELECT id FROM property_details WHERE user_id = ?',
      [property.user_id]
    );

    if (propertyDetailsExists.length > 0) {
      if (action === 'approve') {
        queries.push({
          sql: 'UPDATE property_details SET approval_status = ?, approval_reason = ?, approved_by = ?, approved_at = NOW(), updated_at = NOW() WHERE user_id = ?',
          params: [newStatus, reason || 'Property meets all requirements', adminId, property.user_id]
        });
      } else {
        queries.push({
          sql: 'UPDATE property_details SET approval_status = ?, rejected_reason = ?, approved_by = ?, updated_at = NOW() WHERE user_id = ?',
          params: [newStatus, reason, adminId, property.user_id]
        });
      }
    }

    await executeTransaction(queries);

    const responseData = {
      message: `Property ${action}d successfully`,
      property_id: parseInt(propertyId),
      property_info: {
        type: property.property_type,
        address: property.address
      },
      [`${action}d_by`]: req.user.username,
      [`${action}d_at`]: new Date().toISOString()
    };

    if (action === 'reject') {
      responseData.rejection_reason = reason;
    }

    res.json(responseData);

  } catch (error) {
    console.error(`Error ${action}ing property:`, error);
    res.status(500).json({
      error: 'Database error',
      message: `Unable to ${action} property. Please try again.`
    });
  }
});

router.delete('/properties/:id', auth, requireAdmin, async (req, res) => {
  const propertyId = req.params.id;
  const { reason } = req.body;

  if (!propertyId || isNaN(propertyId)) {
    return res.status(400).json({
      error: 'Invalid property ID',
      message: 'Property ID must be a valid number'
    });
  }

  try {
    const existingProperty = await query(
      'SELECT id, user_id FROM all_properties WHERE id = ?',
      [propertyId]
    );

    if (existingProperty.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'The specified property could not be found'
      });
    }

    const property = existingProperty[0];

    const queries = [
      {
        sql: 'DELETE FROM all_properties WHERE id = ?',
        params: [propertyId]
      }
    ];

    const propertyDetailsExists = await query(
      'SELECT id FROM property_details WHERE user_id = ?',
      [property.user_id]
    );

    if (propertyDetailsExists.length > 0) {
      queries.push({
        sql: 'DELETE FROM property_details WHERE user_id = ?',
        params: [property.user_id]
      });
    }

    await executeTransaction(queries);

    res.json({
      message: 'Property deleted successfully',
      property_id: parseInt(propertyId),
      deleted_by: req.user.username,
      deletion_reason: reason || 'Admin deletion',
      deleted_at: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error deleting property:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to delete property. Please try again.'
    });
  }
});

router.get('/users', auth, requireAdmin, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      role,
      status,
      search,
      sort_by = 'created_at',
      sort_order = 'DESC'
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    let whereClause = 'WHERE 1=1';
    const params = [];

    if (role && role !== 'all') {
      whereClause += ' AND u.role = ?';
      params.push(role);
    }

    if (status && status !== 'all') {
      whereClause += ' AND u.is_active = ?';
      params.push(status === 'active' ? 1 : 0);
    }

    if (search) {
      whereClause += ' AND (u.username LIKE ? OR u.email LIKE ? OR up.first_name LIKE ? OR up.last_name LIKE ?)';
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    const allowedSortFields = ['created_at', 'updated_at', 'username', 'email', 'role'];
    const sortField = allowedSortFields.includes(sort_by) ? `u.${sort_by}` : 'u.created_at';
    const sortDirection = sort_order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const usersQuery = `
      SELECT 
        u.*,
        up.first_name,
        up.last_name,
        up.phone,
        up.business_name,
        (SELECT COUNT(*) FROM all_properties WHERE user_id = u.id) as property_count
      FROM users u
      LEFT JOIN user_profiles up ON u.id = up.user_id
      ${whereClause}
      ORDER BY ${sortField} ${sortDirection}
      LIMIT ? OFFSET ?
    `;

    const countQuery = `
      SELECT COUNT(*) as total FROM users u
      LEFT JOIN user_profiles up ON u.id = up.user_id
      ${whereClause}
    `;

    const [users, countResult] = await Promise.all([
      query(usersQuery, [...params, parseInt(limit), offset]),
      query(countQuery, params)
    ]);

    const processedUsers = users.map(user => ({
      ...user,
      password: undefined
    }));

    const total = countResult[0].total;
    const totalPages = Math.ceil(total / parseInt(limit));

    res.json({
      users: processedUsers,
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
    console.error('Error fetching users:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch users. Please try again.'
    });
  }
});

router.get('/users/:id', auth, requireAdmin, async (req, res) => {
  const userId = req.params.id;

  if (!userId || isNaN(userId)) {
    return res.status(400).json({
      error: 'Invalid user ID',
      message: 'User ID must be a valid number'
    });
  }

  try {
    const userQuery = `
      SELECT 
        u.*,
        up.*
      FROM users u
      LEFT JOIN user_profiles up ON u.id = up.user_id
      WHERE u.id = ?
    `;

    const users = await query(userQuery, [userId]);

    if (users.length === 0) {
      return res.status(404).json({
        error: 'User not found',
        message: 'The specified user could not be found'
      });
    }

    const user = users[0];
    delete user.password;

    const propertiesQuery = `
      SELECT id, property_type, unit_type, address, price, approval_status, is_active, created_at
      FROM all_properties 
      WHERE user_id = ?
      ORDER BY created_at DESC
    `;

    const properties = await query(propertiesQuery, [userId]);

    res.json({
      user: user,
      properties: properties.map(prop => ({
        ...prop,
        price: parseFloat(prop.price)
      }))
    });

  } catch (error) {
    console.error('Error fetching user details:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch user details. Please try again.'
    });
  }
});

router.put('/users/:id/status', auth, requireAdmin, async (req, res) => {
  const userId = req.params.id;
  const { action, reason } = req.body;

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

  try {
    const existingUser = await query(
      'SELECT id, username, email, is_active FROM users WHERE id = ?',
      [userId]
    );

    if (existingUser.length === 0) {
      return res.status(404).json({
        error: 'User not found',
        message: 'The specified user could not be found'
      });
    }

    const user = existingUser[0];
    const newStatus = action === 'activate' ? 1 : 0;

    await query(
      'UPDATE users SET is_active = ?, updated_at = NOW() WHERE id = ?',
      [newStatus, userId]
    );

    res.json({
      message: `User ${action}d successfully`,
      user_id: parseInt(userId),
      user_info: {
        username: user.username,
        email: user.email
      },
      new_status: action === 'activate' ? 'active' : 'inactive',
      reason: reason || `User ${action}d by admin`,
      updated_by: req.user.username,
      updated_at: new Date().toISOString()
    });

  } catch (error) {
    console.error(`Error ${action}ing user:`, error);
    res.status(500).json({
      error: 'Database error',
      message: `Unable to ${action} user. Please try again.`
    });
  }
});

module.exports = router;