const express = require('express');
const router = express.Router();
const { query, executeTransaction } = require('../config/db');
const { auth } = require('../middleware/auth');

/**
 * GET /api/settings
 * Get user settings based on user type
 */
router.get('/', auth, async (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;

  try {
    // Get user and profile data for settings
    const userQuery = `
      SELECT u.id, u.username, u.email, u.role, u.email_verified,
             p.phone, p.first_name, p.last_name, p.nationality
      FROM users u
      LEFT JOIN user_profiles p ON u.id = p.user_id
      WHERE u.id = ?
    `;
    const userResult = await query(userQuery, [userId]);

    if (userResult.length === 0) {
      return res.status(404).json({
        error: 'User not found',
        message: 'User account not found'
      });
    }

    const user = userResult[0];

    // Base settings available to all users
    const settings = {
      account: {
        username: user.username,
        email: user.email,
        email_verified: Boolean(user.email_verified),
        phone: user.phone || '',
        first_name: user.first_name || '',
        last_name: user.last_name || '',
        nationality: user.nationality || ''
      },
      notifications: {
        email_notifications: true,
        booking_updates: true,
        property_updates: true,
        marketing_emails: false
      },
      privacy: {
        profile_visibility: 'public',
        show_phone: true,
        show_email: false
      }
    };

    // Add role-specific settings
    if (userRole === 'propertyowner') {
      // Get property owner specific data
      const ownerQuery = `
        SELECT business_name, contact_person, business_type, business_address
        FROM user_profiles
        WHERE user_id = ?
      `;
      const ownerResult = await query(ownerQuery, [userId]);
      const ownerData = ownerResult[0] || {};

      settings.business = {
        business_name: ownerData.business_name || '',
        contact_person: ownerData.contact_person || '',
        business_type: ownerData.business_type || '',
        business_address: ownerData.business_address || ''
      };
      
      settings.property_management = {
        auto_approve_bookings: false,
        require_advance_payment: true,
        advance_payment_percentage: 30,
        whatsapp_notifications: true,
        whatsapp_number: user.phone || ''
      };
    } else if (userRole === 'admin') {
      settings.admin = {
        dashboard_layout: 'default',
        auto_approve_properties: false,
        notification_frequency: 'immediate',
        system_maintenance_mode: false
      };
    } else if (userRole === 'user') {
      settings.preferences = {
        currency: 'LKR',
        language: 'en',
        property_alerts: true,
        price_range_alerts: true,
        favorite_locations: []
      };
    }

    res.json({
      settings,
      user_role: userRole
    });

  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to retrieve settings. Please try again.'
    });
  }
});

/**
 * PUT /api/settings
 * Update user settings based on user type
 */
router.put('/', auth, async (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;
  const { settings } = req.body;

  if (!settings) {
    return res.status(400).json({
      error: 'Missing data',
      message: 'Settings data is required'
    });
  }

  try {
    const queries = [];

    // Handle account settings updates
    if (settings.account) {
      const accountFields = {};
      const accountParams = [];

      // Update user table fields
      if (settings.account.username && settings.account.username.trim() !== '') {
        accountFields.username = '?';
        accountParams.push(settings.account.username.trim());
      }

      if (Object.keys(accountFields).length > 0) {
        const userUpdateSql = `
          UPDATE users 
          SET ${Object.keys(accountFields).map(key => `${key} = ?`).join(', ')}, updated_at = NOW() 
          WHERE id = ?
        `;
        accountParams.push(userId);
        queries.push({
          sql: userUpdateSql,
          params: accountParams
        });
      }

      // Update profile table fields
      const profileFields = {};
      const profileParams = [];

      ['phone', 'first_name', 'last_name', 'nationality'].forEach(field => {
        if (settings.account[field] !== undefined) {
          profileFields[field] = '?';
          profileParams.push(settings.account[field] || null);
        }
      });

      if (Object.keys(profileFields).length > 0) {
        const profileUpdateSql = `
          UPDATE user_profiles 
          SET ${Object.keys(profileFields).map(key => `${key} = ?`).join(', ')}, updated_at = NOW() 
          WHERE user_id = ?
        `;
        profileParams.push(userId);
        queries.push({
          sql: profileUpdateSql,
          params: profileParams
        });
      }
    }

    // Handle business settings for property owners
    if (userRole === 'propertyowner' && settings.business) {
      const businessFields = {};
      const businessParams = [];

      ['business_name', 'contact_person', 'business_type', 'business_address'].forEach(field => {
        if (settings.business[field] !== undefined) {
          businessFields[field] = '?';
          businessParams.push(settings.business[field] || null);
        }
      });

      if (Object.keys(businessFields).length > 0) {
        const businessUpdateSql = `
          UPDATE user_profiles 
          SET ${Object.keys(businessFields).map(key => `${key} = ?`).join(', ')}, updated_at = NOW() 
          WHERE user_id = ?
        `;
        businessParams.push(userId);
        queries.push({
          sql: businessUpdateSql,
          params: businessParams
        });
      }
    }

    // Execute all queries in a transaction
    if (queries.length > 0) {
      await executeTransaction(queries);
    }

    res.json({
      message: 'Settings updated successfully',
      updated_at: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to update settings. Please try again.'
    });
  }
});

module.exports = router;