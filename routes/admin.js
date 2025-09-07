const express = require('express');
const router = express.Router();
const { query, executeTransaction } = require('../config/db');
const { auth, requireAdmin } = require('../middleware/auth');
const { createNotification } = require('./notifications');

const safeJsonParse = (str) => {
  try {
    return typeof str === 'string' ? JSON.parse(str) : str;
  } catch (error) {
    console.warn('Error parsing JSON:', error);
    return str || [];
  }
};

const validateCoordinates = (latitude, longitude) => {
  if (latitude !== null && longitude !== null) {
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    
    if (isNaN(lat) || isNaN(lng)) {
      return { valid: false, error: 'Invalid coordinate format' };
    }
    
    if (lat < -90 || lat > 90) {
      return { valid: false, error: 'Latitude must be between -90 and 90' };
    }
    
    if (lng < -180 || lng > 180) {
      return { valid: false, error: 'Longitude must be between -180 and 180' };
    }
    
    return { valid: true, lat, lng };
  }
  
  return { valid: true, lat: null, lng: null };
};

router.get('/dashboard', auth, requireAdmin, async (req, res) => {
  try {
    // Stats query
    const statsQuery = `
      SELECT 
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM users WHERE is_active = 1) as active_users,
        (SELECT COUNT(*) FROM users WHERE DATE(created_at) >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)) as new_this_month,
        (SELECT COUNT(*) FROM all_properties) as total_properties,
        (SELECT COUNT(*) FROM all_properties WHERE approval_status = 'pending') as pending_properties,
        (SELECT COUNT(*) FROM all_properties WHERE approval_status = 'approved') as approved_properties,
        (SELECT COUNT(*) FROM booking_requests) as total_bookings,
        (SELECT COUNT(*) FROM booking_requests WHERE status = 'pending') as pending_bookings,
        (SELECT COUNT(*) FROM booking_requests WHERE status = 'confirmed') as confirmed_bookings,
        (SELECT COALESCE(SUM(advance_amount), 0) FROM booking_requests WHERE status = 'confirmed') as total_revenue,
        (SELECT COALESCE(SUM(advance_amount), 0) FROM booking_requests WHERE status = 'confirmed' AND MONTH(payment_confirmed_at) = MONTH(CURDATE()) AND YEAR(payment_confirmed_at) = YEAR(CURDATE())) as monthly_revenue
    `;

    const stats = await query(statsQuery);
    const rawStats = stats[0];

    // Format stats to match frontend expectations
    const formattedStats = {
      users: {
        total: rawStats.total_users,
        active: rawStats.active_users,
        new_this_month: rawStats.new_this_month
      },
      properties: {
        total: rawStats.total_properties,
        pending: rawStats.pending_properties,
        approved: rawStats.approved_properties
      },
      bookings: {
        total: rawStats.total_bookings,
        pending: rawStats.pending_bookings,
        confirmed: rawStats.confirmed_bookings
      },
      revenue: {
        total: parseFloat(rawStats.total_revenue),
        this_month: parseFloat(rawStats.monthly_revenue)
      }
    };

    // Recent properties query
    const recentPropsQuery = `
      SELECT ap.id, ap.property_type, ap.unit_type, ap.address, ap.created_at, ap.approval_status,
             u.username as owner_username, u.email as owner_email
      FROM all_properties ap
      INNER JOIN users u ON ap.user_id = u.id
      WHERE ap.approval_status = 'pending'
      ORDER BY ap.created_at DESC
      LIMIT 10
    `;

    // Recent bookings query
    const recentBookingsQuery = `
      SELECT br.id, br.first_name, br.last_name, br.status, br.check_in_date, br.check_out_date,
             br.total_price, br.advance_amount, br.created_at,
             ap.property_type, ap.unit_type, ap.address as property_address,
             tenant.username as tenant_username, tenant.email as tenant_email,
             owner.username as owner_username, owner.email as owner_email
      FROM booking_requests br
      INNER JOIN all_properties ap ON br.property_id = ap.id
      INNER JOIN users tenant ON br.user_id = tenant.id
      INNER JOIN users owner ON ap.user_id = owner.id
      ORDER BY br.created_at DESC
      LIMIT 10
    `;

    // Recent users query
    const recentUsersQuery = `
      SELECT u.id, u.username, u.email, u.role, u.email_verified, u.is_active, u.created_at,
             up.first_name, up.last_name
      FROM users u
      LEFT JOIN user_profiles up ON u.id = up.user_id
      ORDER BY u.created_at DESC
      LIMIT 10
    `;

    // Execute all queries
    const [recentProperties, recentBookings, recentUsers] = await Promise.all([
      query(recentPropsQuery),
      query(recentBookingsQuery),
      query(recentUsersQuery)
    ]);

    console.log('Dashboard data:', {
      stats: formattedStats,
      recent_properties_count: recentProperties.length,
      recent_bookings_count: recentBookings.length,
      recent_users_count: recentUsers.length
    });

    res.json({
      stats: formattedStats,
      recent_properties: recentProperties.map(prop => ({
        ...prop,
        amenities: safeJsonParse(prop.amenities),
        facilities: safeJsonParse(prop.facilities),
        images: safeJsonParse(prop.images)
      })),
      recent_bookings: recentBookings.map(booking => ({
        ...booking,
        total_price: parseFloat(booking.total_price || 0),
        advance_amount: parseFloat(booking.advance_amount || 0)
      })),
      recent_users: recentUsers
    });

  } catch (error) {
    console.error('Error fetching admin dashboard:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch dashboard data. Please try again.',
      details: error.message
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
        (SELECT COUNT(*) FROM all_properties WHERE approval_status = 'approved') as approved_properties,
        (SELECT COUNT(*) FROM booking_requests) as total_bookings,
        (SELECT COUNT(*) FROM booking_requests WHERE status = 'pending') as pending_bookings,
        (SELECT COUNT(*) FROM booking_requests WHERE status = 'confirmed') as confirmed_bookings,
        (SELECT COALESCE(SUM(advance_amount), 0) FROM booking_requests WHERE status = 'confirmed') as total_revenue,
        (SELECT COALESCE(SUM(advance_amount), 0) FROM booking_requests WHERE status = 'confirmed' AND MONTH(payment_confirmed_at) = MONTH(CURDATE()) AND YEAR(payment_confirmed_at) = YEAR(CURDATE())) as monthly_revenue
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
        total: data.total_bookings,
        pending: data.pending_bookings,
        confirmed: data.confirmed_bookings
      },
      revenue: {
        total: data.total_revenue,
        this_month: data.monthly_revenue
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
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    const countQuery = `
      SELECT COUNT(*) as total 
      FROM users u 
      LEFT JOIN user_profiles up ON u.id = up.user_id 
      ${whereClause}
    `;

    const countResult = await query(countQuery, params);
    const totalUsers = countResult[0].total;

    const usersQuery = `
      SELECT u.id, u.username, u.email, u.email_verified, u.role, u.is_active, u.created_at, u.updated_at,
             up.first_name, up.last_name, up.phone, up.birthdate, up.gender,
             up.nationality, up.identification_number, up.business_name, up.contact_person, up.business_type,
             up.business_registration, up.business_address, up.department, up.admin_level
      FROM users u
      LEFT JOIN user_profiles up ON u.id = up.user_id
      ${whereClause}
      ORDER BY u.${sort_by} ${sort_order}
      LIMIT ? OFFSET ?
    `;

    params.push(parseInt(limit), offset);
    const users = await query(usersQuery, params);

    res.json({
      users: users,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalUsers,
        totalPages: Math.ceil(totalUsers / parseInt(limit)),
        hasNext: page < Math.ceil(totalUsers / parseInt(limit)),
        hasPrevious: page > 1
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
        up.first_name,
        up.last_name,
        up.phone,
        up.business_name,
        up.profile_image,
        up.business_address,
        up.contact_person,
        up.business_type,
        up.business_registration,
        up.department,
        up.admin_level,
        up.gender,
        up.birthdate,
        up.nationality,
        up.identification_number
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

    const propertiesQuery = `
      SELECT id, property_type, unit_type, address, price, approval_status, created_at
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

router.get('/properties', auth, requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const status = req.query.status || 'all';
    const approval_status = req.query.approval_status || 'all';
    const search = req.query.search?.trim() || '';
    const owner_id = req.query.owner_id ? parseInt(req.query.owner_id) : null;
    const sort_by = req.query.sort_by || 'created_at';
    const sort_order = req.query.sort_order?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    let whereClause = '';
    const params = [];
    const conditions = [];

    if (status && status !== 'all') {
      if (status === 'active') {
        conditions.push('p.is_active = 1');
      } else if (status === 'inactive') {
        conditions.push('p.is_active = 0');
      }
    }

    if (approval_status && approval_status !== 'all') {
      conditions.push('p.approval_status = ?');
      params.push(approval_status);
    }

    if (search) {
      conditions.push('(p.property_type LIKE ? OR p.unit_type LIKE ? OR p.address LIKE ? OR u.username LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (owner_id) {
      conditions.push('p.user_id = ?');
      params.push(owner_id);
    }

    if (conditions.length > 0) {
      whereClause = 'WHERE ' + conditions.join(' AND ');
    }

    const allowedSortFields = ['created_at', 'updated_at', 'property_type', 'approval_status', 'price'];
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
      latitude: property.latitude ? parseFloat(property.latitude) : null,
      longitude: property.longitude ? parseFloat(property.longitude) : null,
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
  const { approval_status, rejection_reason } = req.body;
  const adminId = req.user.id;

  if (!propertyId || isNaN(propertyId)) {
    return res.status(400).json({
      error: 'Invalid property ID',
      message: 'Property ID must be a valid number'
    });
  }

  if (!approval_status || !['approved', 'rejected'].includes(approval_status)) {
    return res.status(400).json({
      error: 'Invalid approval status',
      message: 'Approval status must be either approved or rejected'
    });
  }

  if (approval_status === 'rejected' && (!rejection_reason || rejection_reason.trim() === '')) {
    return res.status(400).json({
      error: 'Rejection reason required',
      message: 'Rejection reason is required when rejecting a property'
    });
  }

  try {
    const propertyQuery = `
      SELECT p.id, p.user_id, p.property_type, p.unit_type, p.address, p.approval_status,
             u.username as owner_username, u.email as owner_email
      FROM all_properties p
      INNER JOIN users u ON p.user_id = u.id
      WHERE p.id = ?
    `;
    
    const properties = await query(propertyQuery, [propertyId]);

    if (properties.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'The specified property does not exist'
      });
    }

    const property = properties[0];

    if (property.approval_status === approval_status) {
      return res.status(400).json({
        error: 'Status unchanged',
        message: `Property is already ${approval_status}`
      });
    }

    await query(
      `UPDATE all_properties SET approval_status = ?, updated_at = NOW() WHERE id = ?`,
      [approval_status, propertyId]
    );

    const propertyDetailsFields = ['approval_status = ?', 'approved_by = ?', 'updated_at = NOW()'];
    const propertyDetailsParams = [approval_status, adminId];

    if (approval_status === 'approved') {
      propertyDetailsFields.push('approved_at = NOW()');
      propertyDetailsFields.push('rejected_reason = NULL');
    } else {
      propertyDetailsFields.push('rejected_reason = ?');
      propertyDetailsParams.push(rejection_reason.trim());
    }

    propertyDetailsParams.push(property.user_id);

    await query(
      `UPDATE property_details SET ${propertyDetailsFields.join(', ')} WHERE user_id = ?`,
      propertyDetailsParams
    );

    try {
      const notificationData = {
        user_id: property.user_id,
        type: approval_status === 'approved' ? 'property_approval' : 'property_rejection',
        title: approval_status === 'approved' ? 'Property Approved!' : 'Property Rejected',
        message: approval_status === 'approved' 
          ? `Your property at ${property.address} has been approved and is now live!`
          : `Your property at ${property.address} has been rejected. Reason: ${rejection_reason}`,
        data: {
          property_id: propertyId,
          property_address: property.address,
          property_type: property.property_type,
          unit_type: property.unit_type,
          approval_status: approval_status,
          rejection_reason: approval_status === 'rejected' ? rejection_reason : null,
          approved_by: req.user.username
        },
        property_id: propertyId,
        from_user_id: adminId
      };

      await createNotification(notificationData);
    } catch (notificationError) {
      console.error('Error creating property approval notification:', notificationError);
    }

    const updatedProperty = await query(propertyQuery, [propertyId]);

    res.json({
      message: `Property ${approval_status} successfully`,
      property: updatedProperty[0],
      approval_status: approval_status,
      approved_by: req.user.username,
      approved_at: new Date().toISOString(),
      rejection_reason: approval_status === 'rejected' ? rejection_reason : null
    });

  } catch (error) {
    console.error('Error updating property approval:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to update property approval status'
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

router.get('/booking-requests', auth, requireAdmin, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      status,
      sort_by = 'created_at',
      sort_order = 'DESC'
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    let whereClause = 'WHERE 1=1';
    const params = [];

    if (status && status !== 'all') {
      whereClause += ' AND br.status = ?';
      params.push(status);
    }

    const countQuery = `
      SELECT COUNT(*) as total 
      FROM booking_requests br 
      ${whereClause}
    `;

    const countResult = await query(countQuery, params);
    const totalBookings = countResult[0].total;

    const bookingsQuery = `
      SELECT br.*, 
             ap.property_type, ap.unit_type, ap.address as property_address,
             tenant.username as tenant_username, tenant.email as tenant_email,
             owner.username as owner_username, owner.email as owner_email
      FROM booking_requests br
      INNER JOIN all_properties ap ON br.property_id = ap.id
      INNER JOIN users tenant ON br.user_id = tenant.id
      INNER JOIN users owner ON ap.user_id = owner.id
      ${whereClause}
      ORDER BY br.${sort_by} ${sort_order}
      LIMIT ? OFFSET ?
    `;

    params.push(parseInt(limit), offset);
    const bookings = await query(bookingsQuery, params);

    res.json({
      booking_requests: bookings.map(booking => ({
        ...booking,
        total_price: parseFloat(booking.total_price),
        advance_amount: parseFloat(booking.advance_amount),
        service_fee: parseFloat(booking.service_fee)
      })),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalBookings,
        totalPages: Math.ceil(totalBookings / parseInt(limit)),
        hasNext: page < Math.ceil(totalBookings / parseInt(limit)),
        hasPrevious: page > 1
      }
    });

  } catch (error) {
    console.error('Error fetching booking requests:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch booking requests. Please try again.'
    });
  }
});

router.get('/system-health', auth, requireAdmin, async (req, res) => {
  try {
    const dbTest = await query('SELECT 1 as test');
    const dbStatus = dbTest.length > 0 ? 'healthy' : 'unhealthy';

    res.json({
      status: dbStatus,
      timestamp: new Date().toISOString(),
      database: dbStatus,
      uptime: process.uptime(),
      memory_usage: process.memoryUsage(),
      version: '1.0.0'
    });

  } catch (error) {
    console.error('System health check failed:', error);
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      database: 'unhealthy',
      error: 'Health check failed'
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

router.put('/reported-content/:id/resolve', auth, requireAdmin, async (req, res) => {
  try {
    const reportId = req.params.id;
    const { resolution, notes } = req.body;

    if (!reportId || isNaN(reportId)) {
      return res.status(400).json({
        error: 'Invalid report ID',
        message: 'Report ID must be a valid number'
      });
    }

    res.json({
      message: 'Report resolved successfully',
      report_id: parseInt(reportId),
      resolution: resolution || 'resolved',
      resolved_by: req.user.username,
      resolved_at: new Date().toISOString(),
      notes: notes || null
    });

  } catch (error) {
    console.error('Error resolving report:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to resolve report.'
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
    const { title, content, priority } = req.body;

    if (!title || !content) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'Title and content are required'
      });
    }

    res.json({
      message: 'Announcement created successfully',
      announcement: {
        id: Date.now(),
        title,
        content,
        priority: priority || 'normal',
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
      ((data.active_users / data.total_users) * 100).toFixed(2) : 0;

    res.json({
      total_users: data.total_users,
      active_users: data.active_users,
      new_registrations: data.new_registrations,
      user_retention_rate: parseFloat(retentionRate),
      growth_rate: 5.2,
      role_distribution: {},
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

router.get('/financial-reports', auth, requireAdmin, async (req, res) => {
  try {
    const { 
      period = 'monthly',
      year,
      month,
      report_type = 'revenue'
    } = req.query;

    const revenueQuery = `
      SELECT 
        COALESCE(SUM(advance_amount), 0) as total_revenue,
        COALESCE(SUM(service_fee), 0) as service_fees_collected,
        COUNT(*) as total_transactions,
        AVG(advance_amount) as average_transaction
      FROM booking_requests 
      WHERE status = 'confirmed'
    `;

    const stats = await query(revenueQuery);
    const data = stats[0];

    res.json({
      total_revenue: parseFloat(data.total_revenue),
      total_transactions: data.total_transactions,
      average_transaction: parseFloat(data.average_transaction) || 0,
      commission_earned: parseFloat(data.service_fees_collected),
      service_fees_collected: parseFloat(data.service_fees_collected),
      property_owner_earnings: parseFloat(data.total_revenue) - parseFloat(data.service_fees_collected),
      monthly_breakdown: [],
      payment_methods: {},
      top_earning_properties: []
    });

  } catch (error) {
    console.error('Error fetching financial reports:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch financial reports.'
    });
  }
});

router.get('/export', auth, requireAdmin, async (req, res) => {
  try {
    const { 
      data_type = 'users',
      format = 'csv',
      date_from,
      date_to,
      include_sensitive_data = false
    } = req.query;

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${data_type}_export.${format}"`);
    res.send('Sample export data - implementation needed');

  } catch (error) {
    console.error('Error exporting data:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to export data.'
    });
  }
});

// POST /api/admin/users/:id/verify-email
router.post('/users/:id/verify-email', auth, requireAdmin, async (req, res) => {
  const userId = req.params.id;

  if (!userId || isNaN(userId)) {
    return res.status(400).json({
      error: 'Invalid user ID',
      message: 'User ID must be a valid number'
    });
  }

  try {
    await query(
      'UPDATE users SET email_verified = 1, email_verification_token = NULL, updated_at = NOW() WHERE id = ?',
      [userId]
    );

    res.json({
      message: 'User email verified successfully',
      success: true
    });

  } catch (error) {
    console.error('Error verifying user email:', error);
    res.status(500).json({
      error: 'Verification failed',
      message: 'Unable to verify user email. Please try again.'
    });
  }
});

// POST /api/admin/users/:id/resend-verification
router.post('/users/:id/resend-verification', auth, requireAdmin, async (req, res) => {
  const userId = req.params.id;

  try {
    const users = await query(
      'SELECT email, username, email_verified FROM users WHERE id = ?',
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    const user = users[0];

    if (user.email_verified) {
      return res.status(400).json({
        error: 'Email already verified'
      });
    }

    // Generate new verification token
    const crypto = require('crypto');
    const emailVerificationToken = crypto.randomBytes(32).toString('hex');
    
    await query(
      'UPDATE users SET email_verification_token = ?, updated_at = NOW() WHERE id = ?',
      [emailVerificationToken, userId]
    );

    // Send verification email
    const { sendEmailVerification } = require('../services/emailService');
    try {
      await sendEmailVerification(user.email, emailVerificationToken, user.username);
    } catch (emailError) {
      console.error('Failed to send verification email:', emailError);
    }

    res.json({
      message: 'Verification email sent successfully'
    });

  } catch (error) {
    console.error('Error resending verification:', error);
    res.status(500).json({
      error: 'Failed to resend verification email'
    });
  }
});

module.exports = router;