const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const auth = require('../middleware/auth');
const db = require('../config/db');
const { upload, uploadToCloudinary } = require('../middleware/upload');

// Helper function to validate profile data based on user role
function validateProfileData(profileData, userRole) {
  const { username, email } = profileData;
  
  if (!username || username.trim().length < 3) {
    return { 
      isValid: false, 
      message: 'Username must be at least 3 characters long',
      field: 'username' 
    };
  }
  
  if (!email || !email.includes('@')) {
    return { 
      isValid: false, 
      message: 'Valid email address is required',
      field: 'email' 
    };
  }

  // Role-specific validation
  if (userRole === 'user') {
    const { firstName, lastName } = profileData;
    if (!firstName || firstName.trim().length < 1) {
      return { 
        isValid: false, 
        message: 'First name is required for users',
        field: 'firstName' 
      };
    }
    if (!lastName || lastName.trim().length < 1) {
      return { 
        isValid: false, 
        message: 'Last name is required for users',
        field: 'lastName' 
      };
    }
  } else if (userRole === 'propertyowner') {
    const { businessName, contactPerson } = profileData;
    if (!businessName || businessName.trim().length < 1) {
      return { 
        isValid: false, 
        message: 'Business name is required for property owners',
        field: 'businessName' 
      };
    }
    if (!contactPerson || contactPerson.trim().length < 1) {
      return { 
        isValid: false, 
        message: 'Contact person is required for property owners',
        field: 'contactPerson' 
      };
    }
  }

  return { isValid: true };
}

// Helper function to build profile fields based on user role
function buildProfileFields(profileData, userRole) {
  const baseFields = {
    phone: profileData.phone || null,
    profile_image: profileData.profileImage || null
  };

  if (userRole === 'user') {
    return {
      ...baseFields,
      first_name: profileData.firstName || null,
      last_name: profileData.lastName || null,
      gender: profileData.gender || null,
      birthdate: profileData.birthdate || null,
      nationality: profileData.nationality || null
    };
  } else if (userRole === 'propertyowner') {
    return {
      ...baseFields,
      business_name: profileData.businessName || null,
      contact_person: profileData.contactPerson || null,
      business_type: profileData.businessType || null,
      business_registration: profileData.businessRegistration || null,
      business_address: profileData.businessAddress || null
    };
  } else if (userRole === 'admin') {
    return {
      ...baseFields,
      first_name: profileData.firstName || null,
      last_name: profileData.lastName || null,
      department: profileData.department || null,
      admin_level: profileData.adminLevel || null
    };
  }

  return baseFields;
}

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

      // Update password
      const updatePasswordQuery = `
        UPDATE users 
        SET password = ?, updated_at = NOW()
        WHERE id = ?
      `;

      db.query(updatePasswordQuery, [hashedNewPassword, userId], (err) => {
        if (err) {
          console.error('Error updating password:', err);
          return res.status(500).json({ error: 'Error updating password' });
        }

        res.json({ 
          message: 'Password changed successfully',
          updatedAt: new Date().toISOString()
        });
      });
    });
  } catch (error) {
    console.error('Error in password change process:', error);
    res.status(500).json({ error: 'Error processing password change' });
  }
});

/**
 * POST /api/profile/image
 * Upload a profile picture for the current user
 */
router.post('/image', auth, upload.single('profileImage'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file uploaded' });
  }

  try {
    const userId = req.user.id;
    
    // Upload to cloudinary
    const result = await uploadToCloudinary(req.file.buffer, req.file.originalname);
    
    // Update user profile with new image URL
    const updateQuery = `
      INSERT INTO user_profiles (user_id, profile_image, created_at, updated_at) 
      VALUES (?, ?, NOW(), NOW())
      ON DUPLICATE KEY UPDATE 
      profile_image = VALUES(profile_image), 
      updated_at = NOW()
    `;

    db.query(updateQuery, [userId, result.secure_url], (err) => {
      if (err) {
        console.error('Error updating profile image:', err);
        return res.status(500).json({ error: 'Error saving profile image' });
      }

      res.json({
        message: 'Profile image uploaded successfully',
        imageUrl: result.secure_url
      });
    });

  } catch (error) {
    console.error('Error uploading profile image:', error);
    res.status(500).json({ error: 'Error uploading image' });
  }
});

/**
 * DELETE /api/profile
 * Delete the current user's account (with password confirmation)
 */
router.delete('/', auth, async (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ 
      error: 'Password confirmation is required',
      message: 'Please provide your current password to delete your account'
    });
  }

  // Prevent admin account deletion via this route
  if (userRole === 'admin') {
    return res.status(403).json({ 
      error: 'Admin accounts cannot be deleted via this route',
      message: 'Please contact system administrator for account management'
    });
  }

  try {
    // Verify password
    const getUserQuery = 'SELECT password FROM users WHERE id = ?';
    
    db.query(getUserQuery, [userId], async (err, results) => {
      if (err) {
        console.error('Error fetching user for deletion:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      if (results.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const user = results[0];
      
      // Verify password
      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (!isPasswordValid) {
        return res.status(401).json({ 
          error: 'Password is incorrect',
          message: 'Please enter your current password correctly'
        });
      }

      // Delete user (CASCADE will handle related records)
      const deleteQuery = 'DELETE FROM users WHERE id = ?';
      
      db.query(deleteQuery, [userId], (err) => {
        if (err) {
          console.error('Error deleting user account:', err);
          return res.status(500).json({ error: 'Error deleting account' });
        }

        res.json({ 
          message: 'Account deleted successfully',
          deletedAt: new Date().toISOString()
        });
      });
    });
  } catch (error) {
    console.error('Error in account deletion process:', error);
    res.status(500).json({ error: 'Error processing account deletion' });
  }
});

/**
 * GET /api/profile/stats
 * Get profile statistics for property owners
 */
router.get('/stats', auth, (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;

  if (userRole !== 'propertyowner') {
    return res.status(403).json({ 
      error: 'Access denied',
      message: 'Statistics are only available for property owners'
    });
  }

  // Get various statistics for property owner
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
      console.error('Error fetching profile stats:', err);
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