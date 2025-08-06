const express = require('express');
const router = express.Router();
const { query, executeTransaction } = require('../config/db');
const { auth } = require('../middleware/auth');
const { uploadProfileImage, processFileUpload, handleUploadError } = require('../middleware/upload');

/**
 * GET /api/profile
 * Get user profile information including user data and profile details
 */
router.get('/', auth, async (req, res) => {
  const userId = req.user.id;

  try {
    const userQuery = `
      SELECT id, username, email, role, email_verified, created_at, updated_at 
      FROM users 
      WHERE id = ?
    `;
    const users = await query(userQuery, [userId]);

    if (users.length === 0) {
      return res.status(404).json({
        error: 'User not found',
        message: 'User account not found'
      });
    }

    const user = users[0];

    const profileQuery = `
      SELECT 
        phone, profile_image, first_name, last_name, gender, birthdate, nationality,
        business_name, contact_person, business_type, business_registration, business_address,
        department, admin_level, created_at as profile_created, updated_at as profile_updated
      FROM user_profiles 
      WHERE user_id = ?
    `;
    const profiles = await query(profileQuery, [userId]);

    const profile = profiles.length > 0 ? profiles[0] : null;

    const responseData = {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        email_verified: Boolean(user.email_verified),
        created_at: user.created_at,
        updated_at: user.updated_at
      },
      profile: profile ? {
        phone: profile.phone,
        profile_image: profile.profile_image,
        first_name: profile.first_name,
        last_name: profile.last_name,
        gender: profile.gender,
        birthdate: profile.birthdate,
        nationality: profile.nationality,
        business_name: profile.business_name,
        contact_person: profile.contact_person,
        business_type: profile.business_type,
        business_registration: profile.business_registration,
        business_address: profile.business_address,
        department: profile.department,
        admin_level: profile.admin_level,
        profile_created: profile.profile_created,
        profile_updated: profile.profile_updated
      } : null
    };

    res.json(responseData);

  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to retrieve profile information. Please try again.'
    });
  }
});

/**
 * PUT /api/profile
 * Update user profile information
 * Handles different profile fields based on user role
 */
router.put('/', auth, async (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;
  const profileData = req.body;

  if (!profileData || Object.keys(profileData).length === 0) {
    return res.status(400).json({
      error: 'Missing profile data',
      message: 'Profile data is required for update'
    });
  }

  try {
    const userExists = await query(
      'SELECT id, username, email, role FROM users WHERE id = ?',
      [userId]
    );

    if (userExists.length === 0) {
      return res.status(404).json({
        error: 'User not found',
        message: 'User account not found'
      });
    }

    const queries = [];

    if (profileData.username || profileData.email) {
      const userUpdateFields = {};
      const userUpdateParams = [];

      if (profileData.username && profileData.username !== userExists[0].username) {
        if (profileData.username.length < 3) {
          return res.status(400).json({
            error: 'Invalid username',
            message: 'Username must be at least 3 characters long'
          });
        }

        const existingUsername = await query(
          'SELECT id FROM users WHERE username = ? AND id != ?',
          [profileData.username, userId]
        );

        if (existingUsername.length > 0) {
          return res.status(409).json({
            error: 'Username taken',
            message: 'This username is already taken'
          });
        }

        userUpdateFields.username = '?';
        userUpdateParams.push(profileData.username);
      }

      if (profileData.email && profileData.email !== userExists[0].email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(profileData.email)) {
          return res.status(400).json({
            error: 'Invalid email',
            message: 'Please provide a valid email address'
          });
        }

        const existingEmail = await query(
          'SELECT id FROM users WHERE email = ? AND id != ?',
          [profileData.email, userId]
        );

        if (existingEmail.length > 0) {
          return res.status(409).json({
            error: 'Email taken',
            message: 'This email is already registered'
          });
        }

        userUpdateFields.email = '?';
        userUpdateFields.email_verified = '0';
        userUpdateParams.push(profileData.email);
      }

      if (Object.keys(userUpdateFields).length > 0) {
        const userUpdateSql = `
          UPDATE users 
          SET ${Object.keys(userUpdateFields).map(key => `${key} = ?`).join(', ')}, updated_at = NOW() 
          WHERE id = ?
        `;
        userUpdateParams.push(userId);
        queries.push({
          sql: userUpdateSql,
          params: userUpdateParams
        });
      }
    }

    const profileFields = buildProfileFields(profileData, userRole);
    if (Object.keys(profileFields).length > 0) {
      const existingProfile = await query(
        'SELECT user_id FROM user_profiles WHERE user_id = ?',
        [userId]
      );

      const profileKeys = Object.keys(profileFields);
      const profileValues = Object.values(profileFields);

      if (existingProfile.length > 0) {
        const profileUpdateSql = `
          UPDATE user_profiles 
          SET ${profileKeys.map(key => `${key} = ?`).join(', ')}, updated_at = NOW() 
          WHERE user_id = ?
        `;
        profileValues.push(userId);
        queries.push({
          sql: profileUpdateSql,
          params: profileValues
        });
      } else {
        const profileInsertSql = `
          INSERT INTO user_profiles (user_id, ${profileKeys.join(', ')}, created_at, updated_at) 
          VALUES (?, ${profileKeys.map(() => '?').join(', ')}, NOW(), NOW())
        `;
        queries.push({
          sql: profileInsertSql,
          params: [userId, ...profileValues]
        });
      }
    }

    if (queries.length > 0) {
      await executeTransaction(queries);
    }

    const updatedUser = await query(
      'SELECT id, username, email, role, email_verified, updated_at FROM users WHERE id = ?',
      [userId]
    );

    const updatedProfile = await query(
      `SELECT 
        phone, profile_image, first_name, last_name, gender, birthdate, nationality,
        business_name, contact_person, business_type, business_registration, business_address,
        department, admin_level, updated_at as profile_updated
      FROM user_profiles WHERE user_id = ?`,
      [userId]
    );

    res.json({
      message: 'Profile updated successfully',
      user: updatedUser[0],
      profile: updatedProfile.length > 0 ? updatedProfile[0] : null
    });

  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to update profile. Please try again.'
    });
  }
});

/**
 * POST /api/profile/avatar
 * Upload and update user profile image
 */
router.post('/avatar', auth, uploadProfileImage, processFileUpload, async (req, res) => {
  const userId = req.user.id;

  if (!req.uploadedFile) {
    return res.status(400).json({
      error: 'No file uploaded',
      message: 'Profile image file is required'
    });
  }

  try {
    const existingProfile = await query(
      'SELECT user_id, profile_image FROM user_profiles WHERE user_id = ?',
      [userId]
    );

    const profileImageUrl = req.uploadedFile.url;

    if (existingProfile.length > 0) {
      await query(
        'UPDATE user_profiles SET profile_image = ?, updated_at = NOW() WHERE user_id = ?',
        [profileImageUrl, userId]
      );
    } else {
      await query(
        'INSERT INTO user_profiles (user_id, profile_image, created_at, updated_at) VALUES (?, ?, NOW(), NOW())',
        [userId, profileImageUrl]
      );
    }

    res.json({
      message: 'Profile image updated successfully',
      profile_image: profileImageUrl,
      upload_info: {
        filename: req.uploadedFile.filename,
        size: req.uploadedFile.size,
        url: req.uploadedFile.url
      }
    });

  } catch (error) {
    console.error('Error updating profile image:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to update profile image. Please try again.'
    });
  }
});

/**
 * DELETE /api/profile/avatar
 * Remove user profile image
 */
router.delete('/avatar', auth, async (req, res) => {
  const userId = req.user.id;

  try {
    const existingProfile = await query(
      'SELECT user_id, profile_image FROM user_profiles WHERE user_id = ?',
      [userId]
    );

    if (existingProfile.length === 0 || !existingProfile[0].profile_image) {
      return res.status(404).json({
        error: 'No profile image found',
        message: 'No profile image to remove'
      });
    }

    await query(
      'UPDATE user_profiles SET profile_image = NULL, updated_at = NOW() WHERE user_id = ?',
      [userId]
    );

    res.json({
      message: 'Profile image removed successfully'
    });

  } catch (error) {
    console.error('Error removing profile image:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to remove profile image. Please try again.'
    });
  }
});

/**
 * GET /api/profile/stats
 * Get user activity statistics (for users to see their own activity)
 */
router.get('/stats', auth, async (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;

  try {
    const stats = {
      user_id: userId,
      role: userRole,
      profile_completion: 0,
      activity_summary: {}
    };

    const profileCompletion = await calculateProfileCompletion(userId, userRole);
    stats.profile_completion = profileCompletion;

    if (userRole === 'user') {
      const userActivity = await query(`
        SELECT 
          interaction_type,
          COUNT(*) as count,
          MAX(created_at) as last_activity
        FROM user_interactions 
        WHERE user_id = ?
        GROUP BY interaction_type
      `, [userId]);

      userActivity.forEach(activity => {
        stats.activity_summary[activity.interaction_type] = {
          total: activity.count,
          last_activity: activity.last_activity
        };
      });

    } else if (userRole === 'propertyowner') {
      const propertyStats = await query(`
        SELECT 
          COUNT(*) as total_properties,
          COUNT(CASE WHEN approval_status = 'approved' THEN 1 END) as approved_properties,
          COUNT(CASE WHEN approval_status = 'pending' THEN 1 END) as pending_properties,
          SUM(views_count) as total_views
        FROM all_properties 
        WHERE user_id = ?
      `, [userId]);

      if (propertyStats.length > 0) {
        stats.activity_summary.properties = propertyStats[0];
      }

      const bookingStats = await query(`
        SELECT 
          COUNT(*) as total_bookings,
          COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_bookings,
          COUNT(CASE WHEN status = 'approved' THEN 1 END) as approved_bookings
        FROM booking_requests 
        WHERE property_owner_id = ?
      `, [userId]);

      if (bookingStats.length > 0) {
        stats.activity_summary.bookings = bookingStats[0];
      }

    } else if (userRole === 'admin') {
      const adminStats = await query(`
        SELECT 
          COUNT(CASE WHEN approval_status = 'pending' THEN 1 END) as pending_properties,
          COUNT(CASE WHEN ui.complaint_status = 'pending' THEN 1 END) as pending_complaints
        FROM all_properties ap
        LEFT JOIN user_interactions ui ON ap.id = ui.property_id AND ui.interaction_type = 'complaint'
      `);

      if (adminStats.length > 0) {
        stats.activity_summary.admin_tasks = adminStats[0];
      }
    }

    res.json(stats);

  } catch (error) {
    console.error('Error fetching profile stats:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch profile statistics. Please try again.'
    });
  }
});

/**
 * Helper function to build profile fields based on user role and provided data
 */
function buildProfileFields(profileData, userRole) {
  const fields = {};

  // Common fields for all users
  if (profileData.phone !== undefined) {
    fields.phone = profileData.phone;
  }
  if (profileData.first_name !== undefined) {
    fields.first_name = profileData.first_name;
  }
  if (profileData.last_name !== undefined) {
    fields.last_name = profileData.last_name;
  }
  if (profileData.gender !== undefined) {
    const allowedGenders = ['male', 'female', 'other'];
    if (allowedGenders.includes(profileData.gender)) {
      fields.gender = profileData.gender;
    }
  }
  if (profileData.birthdate !== undefined) {
    fields.birthdate = profileData.birthdate;
  }
  if (profileData.nationality !== undefined) {
    fields.nationality = profileData.nationality;
  }

  // Business fields for property owners
  if (userRole === 'propertyowner') {
    if (profileData.business_name !== undefined) {
      fields.business_name = profileData.business_name;
    }
    if (profileData.contact_person !== undefined) {
      fields.contact_person = profileData.contact_person;
    }
    if (profileData.business_type !== undefined) {
      fields.business_type = profileData.business_type;
    }
    if (profileData.business_registration !== undefined) {
      fields.business_registration = profileData.business_registration;
    }
    if (profileData.business_address !== undefined) {
      fields.business_address = profileData.business_address;
    }
  }

  // Admin fields for administrators
  if (userRole === 'admin') {
    if (profileData.department !== undefined) {
      fields.department = profileData.department;
    }
    if (profileData.admin_level !== undefined) {
      const allowedLevels = ['junior', 'senior', 'manager', 'director'];
      if (allowedLevels.includes(profileData.admin_level)) {
        fields.admin_level = profileData.admin_level;
      }
    }
  }

  return fields;
}

/**
 * Helper function to calculate profile completion percentage
 */
async function calculateProfileCompletion(userId, userRole) {
  try {
    const user = await query(
      'SELECT username, email, email_verified FROM users WHERE id = ?',
      [userId]
    );

    if (user.length === 0) return 0;

    const profile = await query(
      `SELECT 
        phone, profile_image, first_name, last_name, gender, birthdate, nationality,
        business_name, contact_person, business_type, business_registration, business_address,
        department, admin_level
      FROM user_profiles WHERE user_id = ?`,
      [userId]
    );

    let completedFields = 0;
    let totalFields = 0;

    // Basic user fields (always counted)
    totalFields += 5; // username, email, email_verified, first_name, last_name
    if (user[0].username) completedFields++;
    if (user[0].email) completedFields++;
    if (user[0].email_verified) completedFields++;

    if (profile.length > 0) {
      const p = profile[0];
      if (p.first_name) completedFields++;
      if (p.last_name) completedFields++;

      // Optional common fields
      totalFields += 4; // phone, gender, birthdate, nationality
      if (p.phone) completedFields++;
      if (p.gender) completedFields++;
      if (p.birthdate) completedFields++;
      if (p.nationality) completedFields++;

      // Role-specific fields
      if (userRole === 'propertyowner') {
        totalFields += 3; // business_name, contact_person, business_type
        if (p.business_name) completedFields++;
        if (p.contact_person) completedFields++;
        if (p.business_type) completedFields++;
      } else if (userRole === 'admin') {
        totalFields += 2; // department, admin_level
        if (p.department) completedFields++;
        if (p.admin_level) completedFields++;
      }
    }

    return Math.round((completedFields / totalFields) * 100);
  } catch (error) {
    console.error('Error calculating profile completion:', error);
    return 0;
  }
}

// Error handling middleware for this route
router.use(handleUploadError);

module.exports = router;