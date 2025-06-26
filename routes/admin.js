const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const db = require('../config/db');

// Middleware to verify admin role
const requireAdminRole = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ 
      error: 'Access denied. Admin role required.',
      userRole: req.user.role 
    });
  }
  next();
};

// GET /api/admin/pending-properties
// Retrieve all properties awaiting admin approval
router.get('/pending-properties', auth, requireAdminRole, (req, res) => {
  const query = `
    SELECT 
      pd.*,
      u.username as owner_username,
      u.id as owner_id,
      DATE_FORMAT(pd.created_at, '%Y-%m-%d %H:%i:%s') as submission_date
    FROM property_details pd
    LEFT JOIN users u ON pd.user_id = u.id
    WHERE pd.approval_status = 'pending' 
      AND pd.is_deleted = 0
    ORDER BY pd.created_at ASC
  `;

  db.query(query, (err, results) => {
    if (err) {
      console.error('Error fetching pending properties:', err);
      return res.status(500).json({ 
        error: 'Error fetching pending properties',
        details: err.message 
      });
    }

    // Transform the results to include parsed JSON fields
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

// GET /api/admin/approved-properties
// Retrieve all approved properties currently visible to users
router.get('/approved-properties', auth, requireAdminRole, (req, res) => {
  const query = `
    SELECT 
      ap.*,
      u.username as owner_username,
      DATE_FORMAT(ap.approved_at, '%Y-%m-%d %H:%i:%s') as approval_date
    FROM all_properties ap
    LEFT JOIN users u ON ap.user_id = u.id
    WHERE ap.is_active = 1
    ORDER BY ap.approved_at DESC
  `;

  db.query(query, (err, results) => {
    if (err) {
      console.error('Error fetching approved properties:', err);
      return res.status(500).json({ 
        error: 'Error fetching approved properties',
        details: err.message 
      });
    }

    // Process the results to include parsed JSON fields
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

// GET /api/admin/property/:id
// Get property details for admin review (checks both tables)
router.get('/property/:id', auth, requireAdminRole, (req, res) => {
  const propertyId = req.params.id;
  
  // First check if it's a pending property in property_details
  const pendingQuery = `
    SELECT 
      pd.*,
      u.username as owner_username,
      'pending' as source_table
    FROM property_details pd
    LEFT JOIN users u ON pd.user_id = u.id
    WHERE pd.id = ? AND pd.is_deleted = 0
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
      // Found in property_details, return it
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

    // If not found in property_details, check all_properties
    const approvedQuery = `
      SELECT 
        ap.*,
        u.username as owner_username,
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

      // Property not found in either table
      return res.status(404).json({ 
        error: 'Property not found' 
      });
    });
  });
});

// POST /api/admin/approve-property/:id
// Approve a pending property listing
router.post('/approve-property/:id', auth, requireAdminRole, (req, res) => {
  const propertyId = req.params.id;
  const adminId = req.user.id;

  // Start a database transaction to ensure data consistency
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

      // Step 1: Verify the property exists and is pending
      const checkQuery = `
        SELECT * FROM property_details 
        WHERE id = ? AND approval_status = 'pending' AND is_deleted = 0
      `;

      connection.query(checkQuery, [propertyId], (err, results) => {
        if (err) {
          return connection.rollback(() => {
            connection.release();
            console.error('Error checking property:', err);
            res.status(500).json({ error: 'Error checking property status' });
          });
        }

        if (results.length === 0) {
          return connection.rollback(() => {
            connection.release();
            res.status(404).json({ 
              error: 'Property not found or not available for approval' 
            });
          });
        }

        const property = results[0];

        // Step 2: Update the property_details record with approval information
        const updateQuery = `
          UPDATE property_details 
          SET approval_status = 'approved',
              approved_by = ?,
              approved_at = NOW()
          WHERE id = ?
        `;

        connection.query(updateQuery, [adminId, propertyId], (err) => {
          if (err) {
            return connection.rollback(() => {
              connection.release();
              console.error('Error updating property approval:', err);
              res.status(500).json({ error: 'Error updating property status' });
            });
          }

          // Step 3: Copy the approved property to all_properties table
          const insertQuery = `
            INSERT INTO all_properties (
              id, user_id, property_type, unit_type, amenities, facilities, 
              other_facility, roommates, rules, contract_policy, address, 
              available_from, available_to, price_range, bills_inclusive,
              approved_at, approved_by, is_active
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 1)
            ON DUPLICATE KEY UPDATE
              is_active = 1,
              approved_at = NOW(),
              approved_by = ?
          `;

          const insertValues = [
            property.id,
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
            adminId,
            adminId
          ];

          connection.query(insertQuery, insertValues, (err) => {
            if (err) {
              return connection.rollback(() => {
                connection.release();
                console.error('Error adding property to all_properties:', err);
                res.status(500).json({ error: 'Error publishing property' });
              });
            }

            // Commit the transaction
            connection.commit((err) => {
              if (err) {
                return connection.rollback(() => {
                  connection.release();
                  console.error('Error committing transaction:', err);
                  res.status(500).json({ error: 'Error completing approval' });
                });
              }

              connection.release();
              
              res.json({ 
                msg: 'Property approved successfully',
                propertyId: propertyId,
                approvedBy: adminId
              });
            });
          });
        });
      });
    });
  });
});

// POST /api/admin/reject-property/:id
// Reject a pending property listing with a reason
router.post('/reject-property/:id', auth, requireAdminRole, (req, res) => {
  const propertyId = req.params.id;
  const { rejection_reason } = req.body;
  const adminId = req.user.id;

  // Validation: Ensure a rejection reason is provided
  if (!rejection_reason || rejection_reason.trim().length === 0) {
    return res.status(400).json({ 
      error: 'Rejection reason is required',
      field: 'rejection_reason'
    });
  }

  const updateQuery = `
    UPDATE property_details 
    SET approval_status = 'rejected',
        rejection_reason = ?,
        reviewed_by = ?,
        reviewed_at = NOW()
    WHERE id = ? AND approval_status = 'pending' AND is_deleted = 0
  `;

  db.query(updateQuery, [rejection_reason, adminId, propertyId], (err, results) => {
    if (err) {
      console.error('Error rejecting property:', err);
      return res.status(500).json({ 
        error: 'Error rejecting property',
        details: err.message 
      });
    }

    if (results.affectedRows === 0) {
      return res.status(404).json({ 
        error: 'Property not found or not available for rejection' 
      });
    }

    res.json({ 
      msg: 'Property rejected successfully',
      propertyId: propertyId,
      rejectionReason: rejection_reason
    });
  });
});

// POST /api/admin/remove-property/:id
// Remove an approved property from public view
router.post('/remove-property/:id', auth, requireAdminRole, (req, res) => {
  const propertyId = req.params.id;
  const { removal_reason } = req.body;
  const adminId = req.user.id;

  if (!removal_reason || removal_reason.trim().length === 0) {
    return res.status(400).json({ 
      error: 'Removal reason is required',
      field: 'removal_reason'
    });
  }

  const updateQuery = `
    UPDATE all_properties 
    SET is_active = 0,
        removal_reason = ?,
        removed_by = ?,
        removed_at = NOW()
    WHERE id = ? AND is_active = 1
  `;

  db.query(updateQuery, [removal_reason, adminId, propertyId], (err, results) => {
    if (err) {
      console.error('Error removing property:', err);
      return res.status(500).json({ 
        error: 'Error removing property',
        details: err.message 
      });
    }

    if (results.affectedRows === 0) {
      return res.status(404).json({ 
        error: 'Property not found or already inactive' 
      });
    }

    res.json({ 
      msg: 'Property removed successfully',
      propertyId: propertyId,
      removalReason: removal_reason
    });
  });
});

// GET /api/admin/stats
// Get dashboard statistics for admin overview
router.get('/stats', auth, requireAdminRole, (req, res) => {
  const queries = {
    pendingCount: new Promise((resolve, reject) => {
      db.query(
        'SELECT COUNT(*) as count FROM property_details WHERE approval_status = "pending" AND is_deleted = 0',
        (err, results) => {
          if (err) reject(err);
          else resolve(results[0].count);
        }
      );
    }),
    
    approvedCount: new Promise((resolve, reject) => {
      db.query(
        'SELECT COUNT(*) as count FROM all_properties WHERE is_active = 1',
        (err, results) => {
          if (err) reject(err);
          else resolve(results[0].count);
        }
      );
    }),
    
    totalUsers: new Promise((resolve, reject) => {
      db.query(
        'SELECT COUNT(*) as count FROM users WHERE role IN ("user", "propertyowner")',
        (err, results) => {
          if (err) reject(err);
          else resolve(results[0].count);
        }
      );
    }),
    
    recentApprovals: new Promise((resolve, reject) => {
      db.query(
        'SELECT COUNT(*) as count FROM all_properties WHERE approved_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)',
        (err, results) => {
          if (err) reject(err);
          else resolve(results[0].count);
        }
      );
    })
  };

  Promise.all(Object.values(queries))
    .then(([pendingCount, approvedCount, totalUsers, recentApprovals]) => {
      res.json({
        pendingReviews: pendingCount,
        approvedProperties: approvedCount,
        totalUsers: totalUsers,
        recentApprovals: recentApprovals,
        generatedAt: new Date().toISOString()
      });
    })
    .catch(err => {
      console.error('Error fetching admin stats:', err);
      res.status(500).json({ 
        error: 'Error fetching statistics',
        details: err.message 
      });
    });
});

// Utility function to safely parse JSON strings
function safeJsonParse(jsonString) {
  if (!jsonString) return null;
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    console.warn('Invalid JSON string:', jsonString);
    return null;
  }
}

module.exports = router;