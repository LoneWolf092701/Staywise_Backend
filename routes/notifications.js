const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { auth } = require('../middleware/auth');

/**
 * Create a new notification
 * @param {Object} notificationData - Notification details
 * @returns {Promise<Object>} Created notification
 */
const createNotification = async (notificationData) => {
  try {
    const {
      user_id,
      type,
      title,
      message,
      data = null,
      booking_id = null,
      property_id = null,
      from_user_id = null
    } = notificationData;

    // Validate required fields
    if (!user_id || !type || !title || !message) {
      throw new Error('Missing required notification fields');
    }

    // Validate user exists
    const userExists = await query('SELECT id FROM users WHERE id = ?', [user_id]);
    if (userExists.length === 0) {
      throw new Error(`User with ID ${user_id} does not exist`);
    }

    // Validate booking_id if provided
    if (booking_id) {
      const bookingExists = await query('SELECT id FROM booking_requests WHERE id = ?', [booking_id]);
      if (bookingExists.length === 0) {
        console.warn(`Booking with ID ${booking_id} does not exist, setting to null`);
        booking_id = null;
      }
    }

    // Validate property_id if provided
    if (property_id) {
      const propertyExists = await query('SELECT id FROM all_properties WHERE id = ?', [property_id]);
      if (propertyExists.length === 0) {
        console.warn(`Property with ID ${property_id} does not exist, setting to null`);
        property_id = null;
      }
    }

    // Validate from_user_id if provided
    if (from_user_id) {
      const fromUserExists = await query('SELECT id FROM users WHERE id = ?', [from_user_id]);
      if (fromUserExists.length === 0) {
        console.warn(`From user with ID ${from_user_id} does not exist, setting to null`);
        from_user_id = null;
      }
    }

    const result = await query(
      `INSERT INTO notifications 
       (user_id, type, title, message, data, booking_id, property_id, from_user_id, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [user_id, type, title, message, JSON.stringify(data), booking_id, property_id, from_user_id]
    );

    return { id: result.insertId, ...notificationData };
  } catch (error) {
    console.error('Error creating notification:', error);
    throw error;
  }
};

/**
 * GET /api/notifications
 * Get user's notifications with improved error handling
 */
router.get('/', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const unreadOnly = req.query.unread_only === 'true';

    // Validate user exists
    const userExists = await query('SELECT id FROM users WHERE id = ?', [userId]);
    if (userExists.length === 0) {
      return res.status(404).json({
        error: 'User not found',
        message: 'User account not found'
      });
    }

    let whereClause = 'WHERE n.user_id = ?';
    const queryParams = [userId];

    if (unreadOnly) {
      whereClause += ' AND n.read_at IS NULL';
    }

    // Get total count with error handling
    let total = 0;
    try {
      const countQuery = `SELECT COUNT(*) as total FROM notifications n ${whereClause}`;
      const countResult = await query(countQuery, queryParams);
      total = countResult[0].total;
    } catch (countError) {
      console.error('Error getting notification count:', countError);
      // Continue with total = 0 instead of failing
    }

    // Modified query with better error handling and null checks
    const notificationsQuery = `
      SELECT 
        n.id,
        n.user_id,
        n.type,
        n.title,
        n.message,
        n.data,
        n.booking_id,
        n.property_id,
        n.from_user_id,
        n.read_at,
        n.action_taken,
        n.created_at,
        n.updated_at,
        COALESCE(fu.username, 'Unknown User') as from_username,
        COALESCE(fu.email, 'No Email') as from_email,
        CASE 
          WHEN n.booking_id IS NOT NULL AND br.id IS NOT NULL THEN br.first_name
          ELSE NULL 
        END as booking_user_name,
        CASE 
          WHEN n.property_id IS NOT NULL AND ap.id IS NOT NULL THEN ap.address
          ELSE NULL 
        END as property_address
      FROM notifications n
      LEFT JOIN users fu ON n.from_user_id = fu.id AND fu.id IS NOT NULL
      LEFT JOIN booking_requests br ON n.booking_id = br.id AND br.id IS NOT NULL
      LEFT JOIN all_properties ap ON n.property_id = ap.id AND ap.id IS NOT NULL
      ${whereClause}
      ORDER BY n.created_at DESC
      LIMIT ? OFFSET ?
    `;
    
    const finalQueryParams = [...queryParams, limit, offset];
    
    let notifications = [];
    try {
      notifications = await query(notificationsQuery, finalQueryParams);
    } catch (queryError) {
      console.error('Error fetching notifications:', queryError);
      
      // Fallback: try a simpler query without JOINs
      try {
        const fallbackQuery = `
          SELECT 
            n.id,
            n.user_id,
            n.type,
            n.title,
            n.message,
            n.data,
            n.booking_id,
            n.property_id,
            n.from_user_id,
            n.read_at,
            n.action_taken,
            n.created_at,
            n.updated_at,
            NULL as from_username,
            NULL as from_email,
            NULL as booking_user_name,
            NULL as property_address
          FROM notifications n
          ${whereClause}
          ORDER BY n.created_at DESC
          LIMIT ? OFFSET ?
        `;
        
        notifications = await query(fallbackQuery, finalQueryParams);
        console.log('Used fallback query for notifications');
      } catch (fallbackError) {
        console.error('Fallback query also failed:', fallbackError);
        throw fallbackError;
      }
    }

    // Process notifications with error handling for JSON parsing
    const processedNotifications = notifications.map(notification => {
      let parsedData = null;
      try {
        parsedData = notification.data ? JSON.parse(notification.data) : null;
      } catch (parseError) {
        console.warn('Error parsing notification data:', parseError);
        parsedData = null;
      }

      return {
        ...notification,
        data: parsedData,
        read: notification.read_at !== null
      };
    });

    res.json({
      notifications: processedNotifications,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNext: page < Math.ceil(total / limit),
        hasPrevious: page > 1
      }
    });

  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch notifications. Please try again later.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * PUT /api/notifications/:id/read
 * Mark notification as read with improved validation
 */
router.put('/:id/read', auth, async (req, res) => {
  try {
    const notificationId = req.params.id;
    const userId = req.user.id;

    // Validate notification ID
    if (!notificationId || isNaN(notificationId)) {
      return res.status(400).json({
        error: 'Invalid notification ID',
        message: 'Notification ID must be a valid number'
      });
    }

    // Check if notification exists and belongs to user
    const notification = await query(
      'SELECT id, user_id, read_at FROM notifications WHERE id = ?',
      [notificationId]
    );

    if (notification.length === 0) {
      return res.status(404).json({
        error: 'Notification not found',
        message: 'The specified notification does not exist'
      });
    }

    if (notification[0].user_id !== userId) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You can only mark your own notifications as read'
      });
    }

    // Check if already read
    if (notification[0].read_at) {
      return res.json({
        message: 'Notification already marked as read',
        read_at: notification[0].read_at
      });
    }

    // Mark as read
    await query(
      'UPDATE notifications SET read_at = NOW(), updated_at = NOW() WHERE id = ?',
      [notificationId]
    );

    res.json({
      message: 'Notification marked as read',
      read_at: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to mark notification as read. Please try again later.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * PUT /api/notifications/mark-all-read
 * Mark all notifications as read for user with improved error handling
 */
router.put('/mark-all-read', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Check if user has any unread notifications
    const unreadCount = await query(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read_at IS NULL',
      [userId]
    );

    if (unreadCount[0].count === 0) {
      return res.json({
        message: 'No unread notifications found',
        marked_count: 0
      });
    }

    // Mark all as read
    const result = await query(
      'UPDATE notifications SET read_at = NOW(), updated_at = NOW() WHERE user_id = ? AND read_at IS NULL',
      [userId]
    );

    res.json({
      message: 'All notifications marked as read',
      marked_count: result.affectedRows || 0
    });

  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to mark all notifications as read. Please try again later.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * PUT /api/notifications/:id/action
 * Update notification action (accept/reject booking) with improved validation
 */
router.put('/:id/action', auth, async (req, res) => {
  try {
    const notificationId = req.params.id;
    const userId = req.user.id;
    const { action, message: responseMessage } = req.body;

    // Validation
    if (!notificationId || isNaN(notificationId)) {
      return res.status(400).json({
        error: 'Invalid notification ID',
        message: 'Notification ID must be a valid number'
      });
    }

    if (!action || !['accepted', 'rejected'].includes(action)) {
      return res.status(400).json({
        error: 'Invalid action',
        message: 'Action must be accepted or rejected'
      });
    }

    // Get notification with booking details
    const notification = await query(`
      SELECT n.*, 
             CASE WHEN br.id IS NOT NULL THEN br.user_id ELSE NULL END as booking_user_id, 
             CASE WHEN br.id IS NOT NULL THEN br.property_id ELSE NULL END as booking_property_id
      FROM notifications n
      LEFT JOIN booking_requests br ON n.booking_id = br.id
      WHERE n.id = ? AND n.user_id = ?
    `, [notificationId, userId]);

    if (notification.length === 0) {
      return res.status(404).json({
        error: 'Notification not found',
        message: 'The specified notification does not exist or does not belong to you'
      });
    }

    const notif = notification[0];

    if (notif.type !== 'booking_request') {
      return res.status(400).json({
        error: 'Invalid notification type',
        message: 'Only booking request notifications can be acted upon'
      });
    }

    if (!notif.booking_id) {
      return res.status(400).json({
        error: 'Invalid notification',
        message: 'This notification is not associated with a booking request'
      });
    }

    // Update notification action
    await query(
      'UPDATE notifications SET action_taken = ?, read_at = NOW(), updated_at = NOW() WHERE id = ?',
      [action, notificationId]
    );

    // Update booking status
    const bookingStatus = action === 'accepted' ? 'approved' : 'rejected';
    
    const updateResult = await query(
      'UPDATE booking_requests SET status = ?, owner_response_message = ?, owner_responded_at = NOW(), updated_at = NOW() WHERE id = ?',
      [bookingStatus, responseMessage || null, notif.booking_id]
    );

    if (updateResult.affectedRows === 0) {
      console.warn(`No booking found with ID ${notif.booking_id} to update`);
    }

    // Create response notification for the user who made the booking
    if (notif.booking_user_id) {
      try {
        const responseNotificationData = {
          user_id: notif.booking_user_id,
          type: 'booking_response',
          title: `Booking ${action === 'accepted' ? 'Approved' : 'Rejected'}`,
          message: action === 'accepted' 
            ? 'Your booking request has been approved by the property owner!' 
            : 'Your booking request has been rejected by the property owner.',
          data: { 
            original_notification_id: notificationId,
            response_message: responseMessage,
            action: action
          },
          booking_id: notif.booking_id,
          property_id: notif.booking_property_id,
          from_user_id: userId
        };

        await createNotification(responseNotificationData);
      } catch (responseNotificationError) {
        console.error('Error creating response notification:', responseNotificationError);
        // Don't fail the main operation if response notification fails
      }
    }

    res.json({
      message: `Booking ${action} successfully`,
      action: action,
      booking_id: notif.booking_id
    });

  } catch (error) {
    console.error('Error updating notification action:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to process action. Please try again later.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /api/notifications/unread-count
 * Get count of unread notifications with improved error handling
 */
router.get('/unread-count', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await query(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read_at IS NULL',
      [userId]
    );

    res.json({
      unread_count: result[0].count || 0
    });

  } catch (error) {
    console.error('Error getting unread count:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to get unread count. Please try again later.',
      unread_count: 0 // Fallback value
    });
  }
});

/**
 * DELETE /api/notifications/:id
 * Delete notification with improved validation
 */
router.delete('/:id', auth, async (req, res) => {
  try {
    const notificationId = req.params.id;
    const userId = req.user.id;

    // Validate notification ID
    if (!notificationId || isNaN(notificationId)) {
      return res.status(400).json({
        error: 'Invalid notification ID',
        message: 'Notification ID must be a valid number'
      });
    }

    // Check if notification exists and belongs to user
    const notification = await query(
      'SELECT id, user_id FROM notifications WHERE id = ?',
      [notificationId]
    );

    if (notification.length === 0) {
      return res.status(404).json({
        error: 'Notification not found',
        message: 'The specified notification does not exist'
      });
    }

    if (notification[0].user_id !== userId) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You can only delete your own notifications'
      });
    }

    // Delete notification
    const deleteResult = await query('DELETE FROM notifications WHERE id = ?', [notificationId]);

    if (deleteResult.affectedRows === 0) {
      return res.status(500).json({
        error: 'Delete failed',
        message: 'Failed to delete notification'
      });
    }

    res.json({
      message: 'Notification deleted successfully',
      deleted_id: notificationId
    });

  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to delete notification. Please try again later.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = { router, createNotification };