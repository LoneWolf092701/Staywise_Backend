const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireAdmin } = require('../middleware/auth');
const db = require('../config/db');

function safeJsonParse(jsonString) {
  if (!jsonString) return null;
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    console.warn('Invalid JSON string:', jsonString);
    return null;
  }
}

const requireAdminRole = (req, res, next) => {
  if (req.user.role !== 'admin') {
    const roleRedirects = {
      user: '/user-home',
      propertyowner: '/home'
    };
    
    return res.status(403).json({ 
      error: 'Access denied. Admin role required.',
      userRole: req.user.role,
      redirectTo: roleRedirects[req.user.role] || '/login'
    });
  }
  next();
};

router.get('/pending-properties', auth, requireAdminRole, (req, res) => {
  const { page = 1, limit = 20, sortBy = 'created_at', sortOrder = 'ASC' } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const query = `
    SELECT 
      pd.*,
      u.username as owner_username,
      u.email as owner_email,
      u.id as owner_id,
      DATE_FORMAT(pd.created_at, '%Y-%m-%d %H:%i:%s') as submission_date,
      COUNT(*) OVER() as total_count
    FROM property_details pd
    LEFT JOIN users u ON pd.user_id = u.id
    WHERE pd.approval_status = 'pending' 
      AND pd.is_deleted = 0
    ORDER BY pd.${sortBy === 'created_at' ? 'created_at' : 'updated_at'} ${sortOrder === 'DESC' ? 'DESC' : 'ASC'}
    LIMIT ? OFFSET ?
  `;

  db.query(query, [parseInt(limit), offset], (err, results) => {
    if (err) {
      console.error('Error fetching pending properties:', err);
      return res.status(500).json({ 
        error: 'Error fetching pending properties',
        details: err.message 
      });
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

router.get('/approved-properties', auth, requireAdminRole, (req, res) => {
  const { page = 1, limit = 20, sortBy = 'created_at', sortOrder = 'DESC' } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const query = `
    SELECT 
      ap.*,
      u.username as owner_username,
      u.email as owner_email,
      u.id as owner_id,
      DATE_FORMAT(ap.created_at, '%Y-%m-%d %H:%i:%s') as approval_date,
      COUNT(*) OVER() as total_count
    FROM all_properties ap
    LEFT JOIN users u ON ap.user_id = u.id
    WHERE ap.is_active = 1
    ORDER BY ap.${sortBy === 'created_at' ? 'created_at' : 'updated_at'} ${sortOrder === 'DESC' ? 'DESC' : 'ASC'}
    LIMIT ? OFFSET ?
  `;

  db.query(query, [parseInt(limit), offset], (err, results) => {
    if (err) {
      console.error('Error fetching approved properties:', err);
      return res.status(500).json({ 
        error: 'Error fetching approved properties',
        details: err.message 
      });
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

router.get('/property/:id', auth, requireAdminRole, (req, res) => {
  const propertyId = req.params.id;

  const pendingQuery = `
    SELECT 
      pd.*,
      u.username as owner_username,
      u.email as owner_email,
      u.phone as owner_phone,
      'pending' as source_table
    FROM property_details pd
    LEFT JOIN users u ON pd.user_id = u.id
    WHERE pd.id = ?
  `;

  db.query(pendingQuery, [propertyId], (err, pendingResults) => {
    if (err) {
      console.error('Error fetching property from property_details:', err);
      return res.status(500).json({ 
        error: 'Error fetching property details',
        details: err.message 
      });
    }

    if (pendingResults.length > 0) {
      const property = pendingResults[0];
      const processedProperty = {
        ...property,
        amenities: safeJsonParse(property.amenities),
        facilities: safeJsonParse(property.facilities),
        roommates: safeJsonParse(property.roommates),
        rules: safeJsonParse(property.rules),
        price_range: safeJsonParse(property.price_range),
        bills_inclusive: safeJsonParse(property.bills_inclusive)
      };
      return res.json(processedProperty);
    }

    const approvedQuery = `
      SELECT 
        ap.*,
        u.username as owner_username,
        u.email as owner_email,
        u.phone as owner_phone,
        'approved' as source_table
      FROM all_properties ap
      LEFT JOIN users u ON ap.user_id = u.id
      WHERE ap.id = ?
    `;

    db.query(approvedQuery, [propertyId], (err, approvedResults) => {
      if (err) {
        console.error('Error fetching property from all_properties:', err);
        return res.status(500).json({ 
          error: 'Error fetching property details',
          details: err.message 
        });
      }

      if (approvedResults.length > 0) {
        const property = approvedResults[0];
        const processedProperty = {
          ...property,
          amenities: safeJsonParse(property.amenities),
          facilities: safeJsonParse(property.facilities),
          roommates: safeJsonParse(property.roommates),
          rules: safeJsonParse(property.rules),
          price_range: safeJsonParse(property.price_range),
          bills_inclusive: safeJsonParse(property.bills_inclusive)
        };
        return res.json(processedProperty);
      }

      return res.status(404).json({ 
        error: 'Property not found',
        redirectTo: '/admin/new-listings'
      });
    });
  });
});

router.post('/approve-property/:id', auth, requireAdminRole, (req, res) => {
  const propertyId = req.params.id;
  const adminId = req.user.id;
  const { price, notes } = req.body;

  if (!price || isNaN(price) || price <= 0) {
    return res.status(400).json({ 
      error: 'Valid price is required for property approval',
      redirectTo: '/admin/new-listings'
    });
  }

  db.getConnection((err, connection) => {
    if (err) {
      console.error('Error getting database connection:', err);
      return res.status(500).json({ error: 'Database connection error' });
    }

    connection.beginTransaction((err) => {
      if (err) {
        connection.release();
        console.error('Error starting transaction:', err);
        return res.status(500).json({ error: 'Transaction error' });
      }

      const checkQuery = `
        SELECT * FROM property_details 
        WHERE id = ? AND approval_status = 'pending' AND is_deleted = 0
      `;

      connection.query(checkQuery, [propertyId], (err, results) => {
        if (err) {
          return connection.rollback(() => {
            connection.release();
            console.error('Error checking property status:', err);
            res.status(500).json({ error: 'Error verifying property' });
          });
        }

        if (results.length === 0) {
          return connection.rollback(() => {
            connection.release();
            res.status(404).json({ 
              error: 'Property not found or not in pending status',
              redirectTo: '/admin/new-listings'
            });
          });
        }

        const property = results[0];

        const updateStatusQuery = `
          UPDATE property_details 
          SET approval_status = 'approved', 
              admin_notes = ?,
              approved_by = ?,
              approved_at = NOW(),
              updated_at = NOW()
          WHERE id = ?
        `;

        connection.query(updateStatusQuery, [notes || null, adminId, propertyId], (err) => {
          if (err) {
            return connection.rollback(() => {
              connection.release();
              console.error('Error updating property status:', err);
              res.status(500).json({ error: 'Error approving property' });
            });
          }

          const insertApprovedQuery = `
            INSERT INTO all_properties (
              id, user_id, property_type, unit_type, amenities, facilities, 
              other_facility, roommates, rules, contract_policy, address, 
              available_from, available_to, price_range, bills_inclusive, 
              price, is_active, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())
            ON DUPLICATE KEY UPDATE
              property_type = VALUES(property_type),
              unit_type = VALUES(unit_type),
              amenities = VALUES(amenities),
              facilities = VALUES(facilities),
              other_facility = VALUES(other_facility),
              roommates = VALUES(roommates),
              rules = VALUES(rules),
              contract_policy = VALUES(contract_policy),
              address = VALUES(address),
              available_from = VALUES(available_from),
              available_to = VALUES(available_to),
              price_range = VALUES(price_range),
              bills_inclusive = VALUES(bills_inclusive),
              price = VALUES(price),
              is_active = 1,
              updated_at = NOW()
          `;

          const approvedValues = [
            propertyId,
            property.user_id,
            property.property_type,
            property.unit_type,
            property.amenities,
            property.facilities,
            property.other_facility,
            property.roommates,
            property.rules,
            property.contract_policy,
            property.address,
            property.available_from,
            property.available_to,
            property.price_range,
            property.bills_inclusive,
            parseFloat(price)
          ];

          connection.query(insertApprovedQuery, approvedValues, (err) => {
            if (err) {
              return connection.rollback(() => {
                connection.release();
                console.error('Error inserting into all_properties:', err);
                res.status(500).json({ error: 'Error publishing approved property' });
              });
            }

            connection.commit((err) => {
              if (err) {
                return connection.rollback(() => {
                  connection.release();
                  console.error('Error committing approval transaction:', err);
                  res.status(500).json({ error: 'Error finalizing approval' });
                });
              }

              connection.release();
              res.json({
                message: 'Property approved successfully',
                propertyId: propertyId,
                price: parseFloat(price),
                status: 'approved',
                approvedBy: adminId,
                approvedAt: new Date().toISOString(),
                redirectTo: '/admin/new-listings'
              });
            });
          });
        });
      });
    });
  });
});

router.post('/reject-property/:id', auth, requireAdminRole, (req, res) => {
  const propertyId = req.params.id;
  const adminId = req.user.id;
  const { reason } = req.body;

  if (!reason || reason.trim().length < 10) {
    return res.status(400).json({ 
      error: 'Rejection reason is required and must be at least 10 characters long',
      redirectTo: '/admin/new-listings'
    });
  }

  const rejectQuery = `
    UPDATE property_details 
    SET approval_status = 'rejected', 
        rejection_reason = ?,
        rejected_by = ?,
        rejected_at = NOW(),
        updated_at = NOW()
    WHERE id = ? AND approval_status = 'pending' AND is_deleted = 0
  `;

  db.query(rejectQuery, [reason, adminId, propertyId], (err, results) => {
    if (err) {
      console.error('Error rejecting property:', err);
      return res.status(500).json({ error: 'Error rejecting property' });
    }

    if (results.affectedRows === 0) {
      return res.status(404).json({ 
        error: 'Property not found or not in pending status',
        redirectTo: '/admin/new-listings'
      });
    }

    res.json({
      message: 'Property rejected successfully',
      propertyId: propertyId,
      reason: reason,
      status: 'rejected',
      rejectedBy: adminId,
      rejectedAt: new Date().toISOString(),
      redirectTo: '/admin/new-listings'
    });
  });
});

router.get('/stats', auth, requireAdminRole, (req, res) => {
  const statsQuery = `
    SELECT 
      (SELECT COUNT(*) FROM users WHERE role = 'user') as total_users,
      (SELECT COUNT(*) FROM users WHERE role = 'propertyowner') as total_property_owners,
      (SELECT COUNT(*) FROM property_details WHERE approval_status = 'pending' AND is_deleted = 0) as pending_properties,
      (SELECT COUNT(*) FROM all_properties WHERE is_active = 1) as approved_properties,
      (SELECT COUNT(*) FROM property_details WHERE approval_status = 'rejected' AND is_deleted = 0) as rejected_properties,
      (SELECT COUNT(*) FROM booking_requests) as total_bookings,
      (SELECT COUNT(*) FROM booking_requests WHERE status = 'confirmed') as confirmed_bookings,
      (SELECT COUNT(*) FROM booking_requests WHERE status = 'pending') as pending_bookings,
      (SELECT COUNT(*) FROM users WHERE DATE(created_at) = CURDATE()) as new_users_today,
      (SELECT COUNT(*) FROM property_details WHERE DATE(created_at) = CURDATE() AND is_deleted = 0) as new_properties_today,
      (SELECT COALESCE(SUM(views_count), 0) FROM all_properties) as total_property_views
  `;

  db.query(statsQuery, (err, results) => {
    if (err) {
      console.error('Error fetching admin stats:', err);
      return res.status(500).json({ error: 'Error fetching statistics' });
    }

    const stats = results[0];
    
    res.json({
      users: {
        total: stats.total_users,
        propertyOwners: stats.total_property_owners,
        newToday: stats.new_users_today
      },
      properties: {
        pending: stats.pending_properties,
        approved: stats.approved_properties,
        rejected: stats.rejected_properties,
        newToday: stats.new_properties_today
      },
      bookings: {
        total: stats.total_bookings,
        confirmed: stats.confirmed_bookings,
        pending: stats.pending_bookings
      },
      engagement: {
        totalPropertyViews: stats.total_property_views
      }
    });
  });
});

router.get('/users', auth, requireAdminRole, (req, res) => {
  const { role, page = 1, limit = 20, search = '' } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let whereClause = 'WHERE 1=1';
  let queryParams = [];

  if (role && ['user', 'propertyowner'].includes(role)) {
    whereClause += ' AND u.role = ?';
    queryParams.push(role);
  }

  if (search && search.trim()) {
    whereClause += ' AND (u.username LIKE ? OR u.email LIKE ? OR up.first_name LIKE ? OR up.last_name LIKE ?)';
    const searchTerm = `%${search.trim()}%`;
    queryParams.push(searchTerm, searchTerm, searchTerm, searchTerm);
  }

  const query = `
    SELECT 
      u.id,
      u.username,
      u.email,
      u.role,
      u.created_at,
      u.last_login,
      up.first_name,
      up.last_name,
      up.business_name,
      up.phone,
      up.account_status,
      (SELECT COUNT(*) FROM property_details WHERE user_id = u.id AND is_deleted = 0) as property_count,
      (SELECT COUNT(*) FROM booking_requests WHERE user_id = u.id) as booking_count,
      COUNT(*) OVER() as total_count
    FROM users u
    LEFT JOIN user_profiles up ON u.id = up.user_id
    ${whereClause}
    ORDER BY u.created_at DESC
    LIMIT ? OFFSET ?
  `;

  queryParams.push(parseInt(limit), offset);

  db.query(query, queryParams, (err, results) => {
    if (err) {
      console.error('Error fetching users list:', err);
      return res.status(500).json({ error: 'Error fetching users' });
    }

    const totalCount = results.length > 0 ? results[0].total_count : 0;
    const totalPages = Math.ceil(totalCount / parseInt(limit));

    res.json({
      users: results,
      pagination: {
        currentPage: parseInt(page),
        totalPages: totalPages,
        totalUsers: totalCount,
        hasNextPage: parseInt(page) < totalPages,
        hasPrevPage: parseInt(page) > 1
      }
    });
  });
});

router.put('/user/:id/status', auth, requireAdminRole, (req, res) => {
  const userId = req.params.id;
  const { status } = req.body;
  const adminId = req.user.id;

  if (!['active', 'inactive', 'suspended'].includes(status)) {
    return res.status(400).json({ 
      error: 'Status must be "active", "inactive", or "suspended"'
    });
  }

  if (userId == adminId) {
    return res.status(400).json({ 
      error: 'Cannot change your own account status'
    });
  }

  const checkUserQuery = 'SELECT role FROM users WHERE id = ?';
  
  db.query(checkUserQuery, [userId], (err, results) => {
    if (err) {
      console.error('Error checking user:', err);
      return res.status(500).json({ error: 'Error verifying user' });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (results[0].role === 'admin') {
      return res.status(403).json({ 
        error: 'Cannot modify admin account status'
      });
    }

    const updateQuery = `
      INSERT INTO user_profiles (user_id, account_status, updated_at) 
      VALUES (?, ?, NOW())
      ON DUPLICATE KEY UPDATE 
      account_status = VALUES(account_status), 
      updated_at = NOW()
    `;

    db.query(updateQuery, [userId, status], (err) => {
      if (err) {
        console.error('Error updating user status:', err);
        return res.status(500).json({ error: 'Error updating user status' });
      }

      res.json({
        message: `User account ${status === 'active' ? 'activated' : status === 'inactive' ? 'deactivated' : 'suspended'} successfully`,
        userId: userId,
        status: status,
        updatedBy: adminId,
        updatedAt: new Date().toISOString()
      });
    });
  });
});

router.put('/remove-property/:id', auth, requireAdminRole, (req, res) => {
  const propertyId = req.params.id;
  const { reason } = req.body;
  const adminId = req.user.id;

  if (!reason || reason.trim().length < 5) {
    return res.status(400).json({ 
      error: 'Removal reason is required and must be at least 5 characters long'
    });
  }

  db.getConnection((err, connection) => {
    if (err) {
      console.error('Error getting database connection:', err);
      return res.status(500).json({ error: 'Database connection error' });
    }

    connection.beginTransaction((err) => {
      if (err) {
        connection.release();
        console.error('Error starting transaction:', err);
        return res.status(500).json({ error: 'Transaction error' });
      }

      const deactivateQuery = `
        UPDATE all_properties 
        SET is_active = 0, 
            removal_reason = ?,
            removed_by = ?,
            removed_at = NOW(),
            updated_at = NOW()
        WHERE id = ?
      `;

      connection.query(deactivateQuery, [reason.trim(), adminId, propertyId], (err, result) => {
        if (err) {
          return connection.rollback(() => {
            connection.release();
            console.error('Error deactivating property:', err);
            res.status(500).json({ error: 'Error removing property from public view' });
          });
        }

        if (result.affectedRows === 0) {
          return connection.rollback(() => {
            connection.release();
            res.status(404).json({ 
              error: 'Property not found in approved listings',
              redirectTo: '/admin/all-properties'
            });
          });
        }

        const markDeletedQuery = `
          UPDATE property_details 
          SET is_deleted = 1,
              deletion_reason = ?,
              deleted_by = ?,
              deleted_at = NOW(),
              updated_at = NOW()
          WHERE id = ?
        `;

        connection.query(markDeletedQuery, [reason.trim(), adminId, propertyId], (err) => {
          if (err) {
            return connection.rollback(() => {
              connection.release();
              console.error('Error marking property as deleted:', err);
              res.status(500).json({ error: 'Error updating property status' });
            });
          }

          connection.commit((err) => {
            if (err) {
              return connection.rollback(() => {
                connection.release();
                console.error('Error committing removal transaction:', err);
                res.status(500).json({ error: 'Error finalizing property removal' });
              });
            }

            connection.release();
            res.json({
              message: 'Property removed successfully',
              propertyId: propertyId,
              reason: reason.trim(),
              removedBy: adminId,
              removedAt: new Date().toISOString(),
              redirectTo: '/admin/all-properties'
            });
          });
        });
      });
    });
  });
});

router.get('/activity-log', auth, requireAdminRole, (req, res) => {
  const { page = 1, limit = 50, userId, action, startDate, endDate } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let whereClause = 'WHERE 1=1';
  let queryParams = [];

  if (userId) {
    whereClause += ' AND user_id = ?';
    queryParams.push(userId);
  }

  if (action) {
    whereClause += ' AND action = ?';
    queryParams.push(action);
  }

  if (startDate) {
    whereClause += ' AND created_at >= ?';
    queryParams.push(startDate);
  }

  if (endDate) {
    whereClause += ' AND created_at <= ?';
    queryParams.push(endDate);
  }

  const query = `
    SELECT 
      al.*,
      u.username,
      u.role,
      COUNT(*) OVER() as total_count
    FROM activity_logs al
    LEFT JOIN users u ON al.user_id = u.id
    ${whereClause}
    ORDER BY al.created_at DESC
    LIMIT ? OFFSET ?
  `;

  queryParams.push(parseInt(limit), offset);

  db.query(query, queryParams, (err, results) => {
    if (err) {
      console.error('Error fetching activity log:', err);
      return res.status(500).json({ error: 'Error fetching activity log' });
    }

    const totalCount = results.length > 0 ? results[0].total_count : 0;
    const totalPages = Math.ceil(totalCount / parseInt(limit));

    res.json({
      activities: results,
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

module.exports = router;