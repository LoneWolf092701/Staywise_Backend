const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const auth = require('../middleware/auth');
const db = require('../config/db');
const { upload } = require('../middleware/upload');

/**
 * GET /api/profile
 * Retrieve the current user's profile information
 * This route adapts the response based on the user's role
 */
router.get('/', auth, (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;

  // Base query to get common user information
  let query = `
    SELECT 
      u.id,
      u.username,
      u.email,
      u.role,
      u.created_at,
      u.updated_at,
      up.*
    FROM users u
    LEFT JOIN user_profiles up ON u.id = up.user_id
    WHERE u.id = ?
  `;

  db.query(query, [userId], (err, results) => {
    if (err) {
      console.error('Error fetching user profile:', err);
      return res.status(500).json({ 
        error: 'Error fetching profile data',
        details: err.message 
      });
    }

    if (results.length === 0) {
      return res.status(404).json({ 
        error: 'User profile not found' 
      });
    }

    const user = results[0];
    
    // Structure the response based on user role and available data
    const profileData = {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      phone: user.phone || '',
      profileImage: user.profile_image || '',
      emailVerified: user.email_verified || false,
      createdAt: user.created_at,
      updatedAt: user.updated_at
    };

    // Add role-specific fields based on user type
    if (userRole === 'user') {
      profileData.firstName = user.first_name || '';
      profileData.lastName = user.last_name || '';
      profileData.gender = user.gender || '';
      profileData.birthdate = user.birthdate || '';
      profileData.nationality = user.nationality || '';
    } else if (userRole === 'propertyowner') {
      profileData.businessName = user.business_name || '';
      profileData.contactPerson = user.contact_person || '';
      profileData.businessType = user.business_type || '';
      profileData.businessRegistration = user.business_registration || '';
      profileData.businessAddress = user.business_address || '';
    } else if (userRole === 'admin') {
      profileData.firstName = user.first_name || '';
      profileData.lastName = user.last_name || '';
      profileData.department = user.department || '';
      profileData.adminLevel = user.admin_level || '';
    }

    res.json(profileData);
  });
});

/**
 * PUT /api/profile
 * Update the current user's profile information
 * This route handles different fields based on user role
 */
router.put('/', auth, (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;
  const profileData = req.body;

  // Validate required fields based on user role
  const validation = validateProfileData(profileData, userRole);
  if (!validation.isValid) {
    return res.status(400).json({ 
      error: 'Validation failed',
      message: validation.message,
      field: validation.field
    });
  }

  // Start transaction to update both users and user_profiles tables
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

      // Update users table with common fields
      const updateUserQuery = `
        UPDATE users 
        SET username = ?, email = ?, updated_at = NOW()
        WHERE id = ?
      `;

      connection.query(updateUserQuery, [profileData.username, profileData.email, userId], (err) => {
        if (err) {
          return connection.rollback(() => {
            connection.release();
            console.error('Error updating users table:', err);
            
            // Check for duplicate username/email
            if (err.code === 'ER_DUP_ENTRY') {
              return res.status(409).json({ 
                error: 'Username or email already exists',
                message: 'Please choose a different username or email address'
              });
            }
            
            res.status(500).json({ 
              error: 'Error updating profile',
              details: err.message 
            });
          });
        }

        // Prepare data for user_profiles table based on role
        const profileFields = buildProfileFields(profileData, userRole);
        
        // Check if profile exists, then insert or update accordingly
        const checkProfileQuery = 'SELECT user_id FROM user_profiles WHERE user_id = ?';
        connection.query(checkProfileQuery, [userId], (err, results) => {
          if (err) {
            return connection.rollback(() => {
              connection.release();
              console.error('Error checking profile existence:', err);
              res.status(500).json({ error: 'Database error' });
            });
          }

          let profileQuery;
          let queryParams;

          if (results.length > 0) {
            // Update existing profile
            const updateFields = Object.keys(profileFields).map(field => `${field} = ?`).join(', ');
            profileQuery = `UPDATE user_profiles SET ${updateFields}, updated_at = NOW() WHERE user_id = ?`;
            queryParams = [...Object.values(profileFields), userId];
          } else {
            // Insert new profile
            const fields = Object.keys(profileFields).join(', ');
            const placeholders = Object.keys(profileFields).map(() => '?').join(', ');
            profileQuery = `INSERT INTO user_profiles (user_id, ${fields}, created_at, updated_at) VALUES (?, ${placeholders}, NOW(), NOW())`;
            queryParams = [userId, ...Object.values(profileFields)];
          }

          connection.query(profileQuery, queryParams, (err) => {
            if (err) {
              return connection.rollback(() => {
                connection.release();
                console.error('Error updating user profile:', err);
                res.status(500).json({ 
                  error: 'Error updating profile data',
                  details: err.message 
                });
              });
            }

            // Commit the transaction
            connection.commit((err) => {
              if (err) {
                return connection.rollback(() => {
                  connection.release();
                  console.error('Error committing transaction:', err);
                  res.status(500).json({ error: 'Error saving changes' });
                });
              }

              connection.release();
              res.json({ 
                message: 'Profile updated successfully',
                updatedAt: new Date().toISOString()
              });
            });
          });
        });
      });
    });
  });
});

/**
 * PUT /api/profile/password
 * Change the current user's password
 */
router.put('/password', auth, async (req, res) => {
  const userId = req.user.id;
  const { currentPassword, newPassword, confirmPassword } = req.body;

  // Validate password data
  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ 
      error: 'All password fields are required',
      message: 'Please provide current password, new password, and confirmation'
    });
  }

  if (newPassword !== confirmPassword) {
    return res.status(400).json({ 
      error: 'Password confirmation does not match',
      message: 'New password and confirmation must be identical'
    });
  }

  if (newPassword.length < 6) {
    return res.status(422).json({ 
      error: 'Password too short',
      message: 'New password must be at least 6 characters long'
    });
  }

  try {
    // Get current user data to verify current password
    const getUserQuery = 'SELECT password FROM users WHERE id = ?';
    db.query(getUserQuery, [userId], async (err, results) => {
      if (err) {
        console.error('Error fetching user for password change:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      if (results.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const user = results[0];
      
      // Verify current password
      const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password);
      if (!isCurrentPasswordValid) {
        return res.status(401).json({ 
          error: 'Current password is incorrect',
          message: 'Please enter your current password correctly'
        });
      }

      // Hash new password
      const saltRounds = 10;
      const hashedNewPassword = await bcrypt.hash(newPassword, saltRounds);

      // Update password in database
      const updatePasswordQuery = `
        UPDATE users 
        SET password = ?, updated_at = NOW() 
        WHERE id = ?
      `;

      db.query(updatePasswordQuery, [hashedNewPassword, userId], (err) => {
        if (err) {
          console.error('Error updating password:', err);
          return res.status(500).json({ 
            error: 'Error updating password',
            details: err.message 
          });
        }

        res.json({ 
          message: 'Password changed successfully',
          updatedAt: new Date().toISOString()
        });
      });
    });
  } catch (error) {
    console.error('Error in password change process:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'An unexpected error occurred while changing password'
    });
  }
});

/**
 * POST /api/profile/image
 * Upload a profile image for the current user
 */
router.post('/image', auth, upload.single('profileImage'), async (req, res) => {
  const userId = req.user.id;

  if (!req.file) {
    return res.status(400).json({ 
      error: 'No image file provided',
      message: 'Please select an image file to upload'
    });
  }

  try {
    // Here you would typically upload to a cloud service like Cloudinary
    // For now, we'll just store the file path
    const imageUrl = `/uploads/profiles/${req.file.filename}`;

    // Update user profile with new image URL
    const updateImageQuery = `
      INSERT INTO user_profiles (user_id, profile_image, created_at, updated_at)
      VALUES (?, ?, NOW(), NOW())
      ON DUPLICATE KEY UPDATE 
        profile_image = VALUES(profile_image),
        updated_at = NOW()
    `;

    db.query(updateImageQuery, [userId, imageUrl], (err) => {
      if (err) {
        console.error('Error updating profile image:', err);
        return res.status(500).json({ 
          error: 'Error saving profile image',
          details: err.message 
        });
      }

      res.json({ 
        message: 'Profile image uploaded successfully',
        imageUrl: imageUrl
      });
    });
  } catch (error) {
    console.error('Error uploading profile image:', error);
    res.status(500).json({ 
      error: 'Error processing image upload',
      message: 'An unexpected error occurred while uploading the image'
    });
  }
});

/**
 * GET /api/profile/stats
 * Get profile statistics (mainly for property owners)
 */
router.get('/stats', auth, (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;

  if (userRole === 'propertyowner') {
    // Get property owner statistics
    const statsQueries = {
      totalProperties: 'SELECT COUNT(*) as count FROM property_details WHERE user_id = ? AND is_deleted = 0',
      approvedProperties: 'SELECT COUNT(*) as count FROM all_properties WHERE user_id = ? AND is_active = 1',
      pendingProperties: 'SELECT COUNT(*) as count FROM property_details WHERE user_id = ? AND approval_status = "pending" AND is_deleted = 0',
      rejectedProperties: 'SELECT COUNT(*) as count FROM property_details WHERE user_id = ? AND approval_status = "rejected" AND is_deleted = 0'
    };

    const stats = {};
    let completedQueries = 0;
    const totalQueries = Object.keys(statsQueries).length;

    Object.entries(statsQueries).forEach(([key, query]) => {
      db.query(query, [userId], (err, results) => {
        if (err) {
          console.error(`Error fetching ${key}:`, err);
          stats[key] = 0;
        } else {
          stats[key] = results[0].count;
        }

        completedQueries++;
        if (completedQueries === totalQueries) {
          res.json(stats);
        }
      });
    });
  } else if (userRole === 'user') {
    // Get user statistics (favorites, etc.)
    const userStatsQuery = `
      SELECT 
        COUNT(CASE WHEN isFavourite = 1 THEN 1 END) as favoriteProperties,
        COUNT(CASE WHEN complaint IS NOT NULL THEN 1 END) as complaintsSubmitted
      FROM user_property_interactions 
      WHERE user_id = ?
    `;

    db.query(userStatsQuery, [userId], (err, results) => {
      if (err) {
        console.error('Error fetching user stats:', err);
        return res.status(500).json({ error: 'Error fetching statistics' });
      }

      res.json(results[0] || { favoriteProperties: 0, complaintsSubmitted: 0 });
    });
  } else {
    // Admin or other roles - basic account stats
    res.json({
      accountCreated: new Date().toISOString(),
      role: userRole,
      lastLogin: new Date().toISOString()
    });
  }
});

/**
 * Helper function to validate profile data based on user role
 */
function validateProfileData(data, role) {
  // Common validations
  if (!data.username || data.username.trim().length < 3) {
    return { isValid: false, message: 'Username must be at least 3 characters long', field: 'username' };
  }

  if (!data.email || !isValidEmail(data.email)) {
    return { isValid: false, message: 'Please provide a valid email address', field: 'email' };
  }

  // Role-specific validations
  if (role === 'user') {
    if (!data.firstName || data.firstName.trim().length < 2) {
      return { isValid: false, message: 'First name must be at least 2 characters long', field: 'firstName' };
    }
    if (!data.lastName || data.lastName.trim().length < 2) {
      return { isValid: false, message: 'Last name must be at least 2 characters long', field: 'lastName' };
    }
  } else if (role === 'propertyowner') {
    if (!data.businessName || data.businessName.trim().length < 3) {
      return { isValid: false, message: 'Business name must be at least 3 characters long', field: 'businessName' };
    }
    if (!data.contactPerson || data.contactPerson.trim().length < 2) {
      return { isValid: false, message: 'Contact person name must be at least 2 characters long', field: 'contactPerson' };
    }
  }

  return { isValid: true };
}

/**
 * Helper function to build profile fields object based on role
 */
function buildProfileFields(data, role) {
  const fields = {
    phone: data.phone || null
  };

  if (role === 'user') {
    fields.first_name = data.firstName || null;
    fields.last_name = data.lastName || null;
    fields.gender = data.gender || null;
    fields.birthdate = data.birthdate || null;
    fields.nationality = data.nationality || null;
  } else if (role === 'propertyowner') {
    fields.business_name = data.businessName || null;
    fields.contact_person = data.contactPerson || null;
    fields.business_type = data.businessType || null;
    fields.business_registration = data.businessRegistration || null;
    fields.business_address = data.businessAddress || null;
  } else if (role === 'admin') {
    fields.first_name = data.firstName || null;
    fields.last_name = data.lastName || null;
    fields.department = data.department || null;
    fields.admin_level = data.adminLevel || null;
  }

  return fields;
}

/**
 * Helper function to validate email format
 */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

module.exports = router;