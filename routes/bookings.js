const express = require('express');
const router = express.Router();
const { query, executeTransaction } = require('../config/db');
const { auth, requireUser, requirePropertyOwner } = require('../middleware/auth');
const { createNotification } = require('./notifications');
const { 
  upload, 
  processFileUpload, 
  uploadMultipleFiles 
} = require('../middleware/upload');

/**
 * Safe JSON parsing function that handles both JSON and comma-separated string formats
 * This ensures booking operations can display property information regardless of storage format
 * @param {string|object|array|null} value - The value to parse
 * @returns {Array} Array of parsed values
 */
const safeJsonParse = (value) => {
  if (!value) return [];
  
  // If already an array, return it
  if (Array.isArray(value)) return value;
  
  // If it's an object, extract keys where value > 0 (for amenities format)
  if (typeof value === 'object' && value !== null) {
    return Object.keys(value).filter(key => value[key] > 0);
  }
  
  // If it's a string, try to parse as JSON first
  if (typeof value === 'string') {
    // Try JSON parsing first
    try {
      const parsed = JSON.parse(value);
      
      // If parsed is an object (like {"Parking": 1, "Pool": 1}), extract keys where value > 0
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return Object.keys(parsed).filter(key => parsed[key] > 0);
      }
      
      // If parsed is an array, return it
      if (Array.isArray(parsed)) {
        return parsed;
      }
      
      // If single value, wrap in array
      return [parsed];
    } catch (error) {
      // If JSON parsing fails, treat as comma-separated string
      return value.split(',').map(item => item.trim()).filter(item => item.length > 0);
    }
  }
  
  return [];
};

/**
 * POST /api/bookings
 * Create a new booking request (users only)
 */
router.post('/', auth, requireUser, async (req, res) => {
  const userId = req.user.id;
  const {
    property_id, first_name, last_name, email, country_code = '+94', mobile_number,
    birthdate, gender, nationality, occupation, field, destination, relocation_details,
    check_in_date, check_out_date
  } = req.body;

  if (!property_id || !first_name || !last_name || !email || !mobile_number || !check_in_date || !check_out_date) {
    return res.status(400).json({
      error: 'Missing required fields',
      message: 'Property ID, name, email, mobile number, and dates are required'
    });
  }

  const checkInDate = new Date(check_in_date);
  const checkOutDate = new Date(check_out_date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (checkInDate < today) {
    return res.status(400).json({
      error: 'Invalid check-in date',
      message: 'Check-in date cannot be in the past'
    });
  }

  if (checkOutDate <= checkInDate) {
    return res.status(400).json({
      error: 'Invalid dates',
      message: 'Check-out date must be after check-in date'
    });
  }

  try {
    const propertyQuery = `
      SELECT id, user_id, price, property_type, unit_type, address, is_active, approval_status
      FROM all_properties 
      WHERE id = ?
    `;
    const properties = await query(propertyQuery, [property_id]);

    if (properties.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'The specified property does not exist'
      });
    }

    const property = properties[0];

    if (!property.is_active || property.approval_status !== 'approved') {
      return res.status(400).json({
        error: 'Property unavailable',
        message: 'This property is not available for booking'
      });
    }

    if (property.user_id === userId) {
      return res.status(400).json({
        error: 'Cannot book own property',
        message: 'You cannot book your own property'
      });
    }

    const existingBookings = await query(
      `SELECT id FROM booking_requests 
       WHERE property_id = ? AND user_id = ? AND status IN ('pending', 'approved', 'confirmed')
       AND ((check_in_date <= ? AND check_out_date > ?) OR 
            (check_in_date < ? AND check_out_date >= ?) OR
            (check_in_date >= ? AND check_out_date <= ?))`,
      [property_id, userId, check_in_date, check_in_date, check_out_date, check_out_date, check_in_date, check_out_date]
    );

    if (existingBookings.length > 0) {
      return res.status(409).json({
        error: 'Booking conflict',
        message: 'You already have a booking for this property during the selected dates'
      });
    }

    const bookingDays = Math.ceil((checkOutDate - checkInDate) / (1000 * 60 * 60 * 24));
    const bookingMonths = Math.ceil(bookingDays / 30);
    const basePrice = parseFloat(property.price);
    const totalPrice = basePrice * bookingMonths;
    const serviceFee = 300.00;
    const advanceAmount = totalPrice * 0.30;

    const insertQuery = `
      INSERT INTO booking_requests (
        user_id, property_id, property_owner_id, first_name, last_name, email,
        country_code, mobile_number, birthdate, gender, nationality, occupation, field,
        destination, relocation_details, check_in_date, check_out_date, total_price,
        service_fee, advance_amount, booking_days, booking_months, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW(), NOW())
    `;

    const insertResult = await query(insertQuery, [
      userId, property_id, property.user_id, first_name, last_name, email,
      country_code, mobile_number, birthdate || null, gender || null, 
      nationality || null, occupation || null, field || null, 
      destination || null, relocation_details || null, check_in_date, 
      check_out_date, totalPrice, serviceFee, advanceAmount, bookingDays, bookingMonths
    ]);

    const bookingId = insertResult.insertId;

    // Create notification for property owner
    try {
      await createNotification({
        user_id: property.user_id,
        type: 'booking_request',
        title: 'New Booking Request',
        message: `${first_name} ${last_name} has requested to book your property at ${property.address}`,
        data: {
          booking_id: bookingId,
          tenant_name: `${first_name} ${last_name}`,
          tenant_email: email,
          tenant_phone: `${country_code}${mobile_number}`,
          check_in_date: check_in_date,
          check_out_date: check_out_date,
          total_price: totalPrice,
          advance_amount: advanceAmount,
          booking_days: bookingDays,
          property_address: property.address
        },
        booking_id: bookingId,
        property_id: property_id,
        from_user_id: userId
      });
    } catch (notificationError) {
      console.error('Error creating notification:', notificationError);
    }

    const newBooking = await query(`
      SELECT 
        br.*,
        ap.property_type, ap.unit_type, ap.address as property_address,
        u.username as owner_username
      FROM booking_requests br
      INNER JOIN all_properties ap ON br.property_id = ap.id
      INNER JOIN users u ON br.property_owner_id = u.id
      WHERE br.id = ?
    `, [bookingId]);

    res.status(201).json({
      message: 'Booking request submitted successfully',
      booking: newBooking[0],
      status: 'pending'
    });

  } catch (error) {
    console.error('Error creating booking:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to create booking request. Please try again.'
    });
  }
});

/**
 * GET /api/bookings
 * Get user's booking requests (users only)
 */
router.get('/', auth, requireUser, async (req, res) => {
  const userId = req.user.id;
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const offset = (page - 1) * limit;
  const status = req.query.status;

  try {
    let whereClause = 'WHERE br.user_id = ?';
    let queryParams = [userId];

    if (status && ['pending', 'approved', 'rejected', 'cancelled'].includes(status)) {
      whereClause += ' AND br.status = ?';
      queryParams.push(status);
    }

    const countQuery = `SELECT COUNT(*) as total FROM booking_requests br ${whereClause}`;
    const countResult = await query(countQuery, queryParams);
    const totalBookings = countResult[0].total;

    const bookingsQuery = `
      SELECT 
        br.*,
        ap.property_type, ap.unit_type, ap.address as property_address, ap.price,
        ap.images, u.username as owner_username
      FROM booking_requests br
      INNER JOIN all_properties ap ON br.property_id = ap.id
      INNER JOIN users u ON br.property_owner_id = u.id
      ${whereClause}
      ORDER BY br.created_at DESC
      LIMIT ? OFFSET ?
    `;
    queryParams.push(limit, offset);

    const bookings = await query(bookingsQuery, queryParams);

    const processedBookings = bookings.map(booking => ({
      ...booking,
      images: safeJsonParse(booking.images),
      price: parseFloat(booking.price),
      total_price: parseFloat(booking.total_price),
      advance_amount: parseFloat(booking.advance_amount)
    }));

    res.json({
      bookings: processedBookings,
      pagination: {
        page: page,
        limit: limit,
        total: totalBookings,
        totalPages: Math.ceil(totalBookings / limit),
        hasNext: page < Math.ceil(totalBookings / limit),
        hasPrevious: page > 1
      }
    });

  } catch (error) {
    console.error('Error fetching user bookings:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch bookings. Please try again.'
    });
  }
});

/**
 * GET /api/bookings/owner
 * Get booking requests for property owner (property owners only)
 */
router.get('/owner', auth, requirePropertyOwner, async (req, res) => {
  const ownerId = req.user.id;
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const offset = (page - 1) * limit;
  const status = req.query.status;

  try {
    let whereClause = 'WHERE br.property_owner_id = ?';
    let queryParams = [ownerId];

    if (status && ['pending', 'approved', 'rejected', 'cancelled'].includes(status)) {
      whereClause += ' AND br.status = ?';
      queryParams.push(status);
    }

    const countQuery = `SELECT COUNT(*) as total FROM booking_requests br ${whereClause}`;
    const countResult = await query(countQuery, queryParams);
    const totalBookings = countResult[0].total;

    const bookingsQuery = `
      SELECT 
        br.*,
        ap.property_type, ap.unit_type, ap.address as property_address, ap.price,
        ap.images, u.username as tenant_username, u.email as tenant_email
      FROM booking_requests br
      INNER JOIN all_properties ap ON br.property_id = ap.id
      INNER JOIN users u ON br.user_id = u.id
      ${whereClause}
      ORDER BY br.created_at DESC
      LIMIT ? OFFSET ?
    `;
    queryParams.push(limit, offset);

    const bookings = await query(bookingsQuery, queryParams);

    const processedBookings = bookings.map(booking => ({
      ...booking,
      images: safeJsonParse(booking.images),
      price: parseFloat(booking.price),
      total_price: parseFloat(booking.total_price),
      advance_amount: parseFloat(booking.advance_amount)
    }));

    res.json({
      bookings: processedBookings,
      pagination: {
        page: page,
        limit: limit,
        total: totalBookings,
        totalPages: Math.ceil(totalBookings / limit),
        hasNext: page < Math.ceil(totalBookings / limit),
        hasPrevious: page > 1
      }
    });

  } catch (error) {
    console.error('Error fetching owner bookings:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch bookings. Please try again.'
    });
  }
});

/**
 * GET /api/bookings/user  
 * Get user's booking requests (matches frontend API call)
 */
router.get('/user', auth, async (req, res) => {
  const userId = req.user.id;
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const offset = (page - 1) * limit;
  const status = req.query.status;

  try {
    let whereClause = 'WHERE br.user_id = ?';
    let queryParams = [userId];

    if (status && status !== 'all' && ['pending', 'approved', 'payment_submitted', 'confirmed', 'rejected', 'cancelled'].includes(status)) {
      whereClause += ' AND br.status = ?';
      queryParams.push(status);
    }

    const countQuery = `SELECT COUNT(*) as total FROM booking_requests br ${whereClause}`;
    const countResult = await query(countQuery, queryParams);
    const totalBookings = countResult[0].total;

    const bookingsQuery = `
      SELECT 
        br.*,
        ap.property_type, ap.unit_type, ap.address as property_address, ap.price,
        ap.images, ap.amenities, ap.facilities, ap.description,
        u.username as owner_username, u.email as owner_email
      FROM booking_requests br
      INNER JOIN all_properties ap ON br.property_id = ap.id
      INNER JOIN users u ON br.property_owner_id = u.id
      ${whereClause}
      ORDER BY br.created_at DESC
      LIMIT ? OFFSET ?
    `;
    queryParams.push(limit, offset);

    const bookings = await query(bookingsQuery, queryParams);

    const processedBookings = bookings.map(booking => ({
      ...booking,
      images: safeJsonParse(booking.images),
      amenities: safeJsonParse(booking.amenities),
      facilities: safeJsonParse(booking.facilities),
      price: parseFloat(booking.price),
      total_price: parseFloat(booking.total_price),
      advance_amount: parseFloat(booking.advance_amount),
      service_fee: parseFloat(booking.service_fee || 0)
    }));

    res.json({
      bookings: processedBookings,
      pagination: {
        page: page,
        limit: limit,
        total: totalBookings,
        totalPages: Math.ceil(totalBookings / limit),
        hasNext: page < Math.ceil(totalBookings / limit),
        hasPrevious: page > 1
      }
    });

  } catch (error) {
    console.error('Error fetching user bookings:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch bookings. Please try again.'
    });
  }
});

/**
 * GET /api/bookings/:id
 * Get specific booking details
 */
router.get('/:id', auth, async (req, res) => {
  const bookingId = req.params.id;
  const userId = req.user.id;
  const userRole = req.user.role;

  if (!bookingId || isNaN(bookingId)) {
    return res.status(400).json({
      error: 'Invalid booking ID',
      message: 'Booking ID must be a valid number'
    });
  }

  try {
    const bookingQuery = `
      SELECT 
        br.*,
        ap.property_type, ap.unit_type, ap.address as property_address, ap.price,
        ap.amenities, ap.facilities, ap.images, ap.description,
        tenant.username as tenant_username, tenant.email as tenant_email,
        owner.username as owner_username, owner.email as owner_email
      FROM booking_requests br
      INNER JOIN all_properties ap ON br.property_id = ap.id
      INNER JOIN users tenant ON br.user_id = tenant.id
      INNER JOIN users owner ON br.property_owner_id = owner.id
      WHERE br.id = ?
    `;

    const bookings = await query(bookingQuery, [bookingId]);

    if (bookings.length === 0) {
      return res.status(404).json({
        error: 'Booking not found',
        message: 'The specified booking does not exist'
      });
    }

    const booking = bookings[0];

    const canAccess = userRole === 'admin' || 
                     booking.user_id === userId || 
                     booking.property_owner_id === userId;

    if (!canAccess) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You can only view your own bookings'
      });
    }

    const processedBooking = {
      ...booking,
      amenities: safeJsonParse(booking.amenities),
      facilities: safeJsonParse(booking.facilities),
      images: safeJsonParse(booking.images),
      price: parseFloat(booking.price),
      advance_amount: parseFloat(booking.advance_amount)
    };

    res.json(processedBooking);

  } catch (error) {
    console.error('Error fetching booking:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch booking details. Please try again.'
    });
  }
});

/**
 * PUT /api/bookings/:id/status
 * Update booking status (property owners can approve/reject, users can cancel)
 */
router.put('/:id/status', auth, async (req, res) => {
  const bookingId = req.params.id;
  const userId = req.user.id;
  const userRole = req.user.role;
  const { status, message: statusMessage } = req.body;

  if (!bookingId || isNaN(bookingId)) {
    return res.status(400).json({
      error: 'Invalid booking ID',
      message: 'Booking ID must be a valid number'
    });
  }

  const allowedStatuses = ['approved', 'rejected', 'cancelled'];
  if (!status || !allowedStatuses.includes(status)) {
    return res.status(400).json({
      error: 'Invalid status',
      message: `Status must be one of: ${allowedStatuses.join(', ')}`
    });
  }

  try {
    // Get booking details
    const existingBooking = await query(
      'SELECT id, user_id, property_owner_id, status, property_id FROM booking_requests WHERE id = ?',
      [bookingId]
    );

    if (existingBooking.length === 0) {
      return res.status(404).json({
        error: 'Booking not found',
        message: 'The specified booking does not exist'
      });
    }

    const booking = existingBooking[0];

    // Check permissions
    if (status === 'cancelled' && booking.user_id !== userId) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'Only the booking requester can cancel'
      });
    }

    if ((status === 'approved' || status === 'rejected') && booking.property_owner_id !== userId) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'Only the property owner can approve or reject bookings'
      });
    }

    if (booking.status !== 'pending') {
      return res.status(400).json({
        error: 'Cannot update booking',
        message: 'Only pending bookings can be updated'
      });
    }

    // Update booking status
    const updateFields = ['status = ?', 'updated_at = NOW()'];
    const updateParams = [status];

    if (status === 'approved' || status === 'rejected') {
      updateFields.push('owner_response_message = ?', 'owner_responded_at = NOW()');
      updateParams.push(statusMessage || null);
    }

    updateParams.push(bookingId);

    await query(
      `UPDATE booking_requests SET ${updateFields.join(', ')} WHERE id = ?`,
      updateParams
    );

    // Create notification for user about booking response
    if (status === 'approved' || status === 'rejected') {
      try {
        await createNotification({
          user_id: booking.user_id,
          type: 'booking_response',
          title: `Booking ${status === 'approved' ? 'Approved' : 'Rejected'}`,
          message: status === 'approved' 
            ? 'Your booking request has been approved by the property owner!' 
            : 'Your booking request has been rejected by the property owner.',
          data: {
            booking_id: bookingId,
            status: status,
            response_message: statusMessage,
            responded_by: req.user.username
          },
          booking_id: bookingId,
          property_id: booking.property_id,
          from_user_id: userId
        });
      } catch (notificationError) {
        console.error('Error creating response notification:', notificationError);
      }
    }

    // Get updated booking
    const updatedBooking = await query(`
      SELECT 
        br.*,
        ap.property_type, ap.unit_type, ap.address as property_address,
        u.username as tenant_username
      FROM booking_requests br
      INNER JOIN all_properties ap ON br.property_id = ap.id
      INNER JOIN users u ON br.user_id = u.id
      WHERE br.id = ?
    `, [bookingId]);

    res.json({
      message: `Booking ${status} successfully`,
      booking: updatedBooking[0],
      old_status: booking.status,
      new_status: status,
      updated_by: req.user.username,
      updated_at: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error updating booking status:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to update booking status. Please try again.'
    });
  }
});

/**
 * PUT /api/bookings/:id
 * Update booking details (users can update their own pending bookings)
 */
router.put('/:id', auth, requireUser, async (req, res) => {
  const bookingId = req.params.id;
  const userId = req.user.id;
  const updateData = req.body;

  if (!bookingId || isNaN(bookingId)) {
    return res.status(400).json({
      error: 'Invalid booking ID',
      message: 'Booking ID must be a valid number'
    });
  }

  try {
    // Check if booking exists and belongs to user
    const existingBooking = await query(
      'SELECT id, user_id, status FROM booking_requests WHERE id = ?',
      [bookingId]
    );

    if (existingBooking.length === 0) {
      return res.status(404).json({
        error: 'Booking not found',
        message: 'The specified booking does not exist'
      });
    }

    const booking = existingBooking[0];

    if (booking.user_id !== userId) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You can only update your own bookings'
      });
    }

    if (booking.status !== 'pending') {
      return res.status(400).json({
        error: 'Cannot update booking',
        message: 'Only pending bookings can be updated'
      });
    }

    // Build update query for allowed fields
    const allowedFields = [
      'first_name', 'last_name', 'email', 'mobile_number', 'birthdate', 'gender',
      'nationality', 'occupation', 'field', 'destination', 'purpose', 'requirements',
      'stay_duration', 'preferred_start_date', 'budget_range', 'adults', 'children',
      'pets', 'special_needs', 'emergency_contact_name', 'emergency_contact_phone'
    ];

    const updateFields = {};
    allowedFields.forEach(field => {
      if (updateData[field] !== undefined) {
        if (field === 'email') {
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(updateData[field])) {
            throw new Error('Invalid email format');
          }
        }
        updateFields[field] = updateData[field];
      }
    });

    if (Object.keys(updateFields).length === 0) {
      return res.status(400).json({
        error: 'No valid fields to update',
        message: 'Please provide valid fields to update'
      });
    }

    const setClause = Object.keys(updateFields).map(field => `${field} = ?`).join(', ');
    const values = Object.values(updateFields);
    values.push(bookingId);

    await query(
      `UPDATE booking_requests SET ${setClause}, updated_at = NOW() WHERE id = ?`,
      values
    );

    // Get updated booking
    const updatedBooking = await query(
      'SELECT * FROM booking_requests WHERE id = ?',
      [bookingId]
    );

    res.json({
      message: 'Booking updated successfully',
      booking: updatedBooking[0]
    });

  } catch (error) {
    console.error('Error updating booking:', error);
    res.status(500).json({
      error: 'Database error',
      message: error.message || 'Unable to update booking. Please try again.'
    });
  }
});

/**
 * DELETE /api/bookings/:id
 * Delete booking (users can delete their own bookings, owners can delete bookings for their properties)
 */
router.delete('/:id', auth, async (req, res) => {
  const bookingId = req.params.id;
  const userId = req.user.id;

  if (!bookingId || isNaN(bookingId)) {
    return res.status(400).json({
      error: 'Invalid booking ID',
      message: 'Booking ID must be a valid number'
    });
  }

  try {
    // Check if booking exists and user has permission
    const existingBooking = await query(
      'SELECT id, user_id, property_owner_id, status FROM booking_requests WHERE id = ?',
      [bookingId]
    );

    if (existingBooking.length === 0) {
      return res.status(404).json({
        error: 'Booking not found',
        message: 'The specified booking does not exist'
      });
    }

    const booking = existingBooking[0];

    if (booking.user_id !== userId && booking.property_owner_id !== userId) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You can only delete your own bookings'
      });
    }

    if (['confirmed', 'payment_submitted'].includes(booking.status)) {
      return res.status(400).json({
        error: 'Cannot delete booking',
        message: 'Confirmed bookings cannot be deleted'
      });
    }

    await query('DELETE FROM booking_requests WHERE id = ?', [bookingId]);

    res.json({
      message: 'Booking deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting booking:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to delete booking. Please try again.'
    });
  }
});

// GET /api/bookings/user/stats  
router.get('/user/stats', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    const [activeBookings] = await Promise.all([
      query('SELECT COUNT(*) as activeBookings FROM booking_requests WHERE user_id = ? AND status IN ("approved", "payment_submitted", "confirmed")', [userId])
    ]);

    res.json({
      activeBookings: activeBookings[0]?.activeBookings || 0
    });
  } catch (error) {
    console.error('Error fetching booking stats:', error);
    res.status(500).json({ error: 'Failed to fetch booking stats' });
  }
});

/**
 * POST /api/bookings/:id/owner-response
 * Handle owner response with account number (added for booking flow)
 */
router.post('/:id/owner-response', auth, requirePropertyOwner, async (req, res) => {
  const bookingId = req.params.id;
  const { action, account_number, message } = req.body;
  const ownerId = req.user.id;

  if (!action || !['approve', 'reject'].includes(action)) {
    return res.status(400).json({
      error: 'Invalid action',
      message: 'Action must be approve or reject'
    });
  }

  try {
    // Verify booking belongs to owner
    const booking = await query(
      'SELECT * FROM booking_requests WHERE id = ? AND property_owner_id = ?',
      [bookingId, ownerId]
    );

    if (booking.length === 0) {
      return res.status(404).json({
        error: 'Booking not found or access denied'
      });
    }

    if (booking[0].status !== 'pending') {
      return res.status(400).json({
        error: 'Booking is no longer pending'
      });
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    const responseMessage = message || (action === 'approve' ? 'Booking approved' : 'Booking rejected');

    // Update booking status and account info
    await query(
      `UPDATE booking_requests 
       SET status = ?, owner_response_message = ?, payment_account_info = ?, owner_responded_at = NOW() 
       WHERE id = ?`,
      [newStatus, responseMessage, account_number || null, bookingId]
    );

    // Get user phone for WhatsApp notification
    const userProfile = await query(
      'SELECT up.phone_number FROM users u LEFT JOIN user_profiles up ON u.id = up.user_id WHERE u.id = ?',
      [booking[0].user_id]
    );

    // Create notification for user
    const notificationType = action === 'approve' ? 'booking_approved_payment' : 'booking_response';
    const notificationTitle = action === 'approve' ? 'Booking Approved - Payment Required' : 'Booking Rejected';
    const notificationMessage = action === 'approve' 
      ? `Your booking has been approved. Account number: ${account_number}. Please complete payment.`
      : `Your booking has been rejected. ${responseMessage}`;

    await query(
      `INSERT INTO notifications (user_id, type, title, message, booking_id, from_user_id, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        booking[0].user_id,
        notificationType,
        notificationTitle,
        notificationMessage,
        bookingId,
        ownerId,
        JSON.stringify({ account_number: account_number || null, action })
      ]
    );

    res.json({
      message: `Booking ${action}d successfully`,
      booking_id: bookingId,
      status: newStatus
    });

  } catch (error) {
    console.error('Error processing owner response:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to process response. Please try again.'
    });
  }
});

/**
 * POST /api/bookings/:id/upload-receipt
 * Handle receipt and NIC photo upload (added for booking flow)
 */
router.post('/:id/upload-receipt', auth, upload.fields([
  { name: 'receipt', maxCount: 1 },
  { name: 'nic', maxCount: 1 }
]), async (req, res) => {
  const bookingId = req.params.id;
  const userId = req.user.id;

  try {
    // Verify booking belongs to user and is approved
    const booking = await query(
      'SELECT * FROM booking_requests WHERE id = ? AND user_id = ?',
      [bookingId, userId]
    );

    if (booking.length === 0) {
      return res.status(404).json({
        error: 'Booking not found'
      });
    }

    if (booking[0].status !== 'approved') {
      return res.status(400).json({
        error: 'Booking must be approved for payment submission'
      });
    }

    if (!req.files || !req.files.receipt || !req.files.nic) {
      return res.status(400).json({
        error: 'Both receipt and NIC photo are required'
      });
    }

    const receiptUrl = `/uploads/${req.files.receipt[0].filename}`;
    const nicUrl = `/uploads/${req.files.nic[0].filename}`;

    // Update booking with receipt and NIC
    await query(
      `UPDATE booking_requests 
       SET payment_proof_url = ?, verification_document_url = ?, 
           verification_document_type = 'nic', payment_method = 'receipt_upload',
           status = 'payment_submitted', payment_submitted_at = NOW()
       WHERE id = ?`,
      [receiptUrl, nicUrl, bookingId]
    );

    // Notify owner about receipt submission
    await query(
      `INSERT INTO notifications (user_id, type, title, message, booking_id, from_user_id, data)
       VALUES (?, 'payment_submitted', 'Payment Receipt Submitted', 
               'A tenant has submitted payment receipt and NIC for review.', ?, ?, ?)`,
      [
        booking[0].property_owner_id,
        bookingId,
        userId,
        JSON.stringify({ receipt_url: receiptUrl, nic_url: nicUrl })
      ]
    );

    res.json({
      message: 'Payment receipt and NIC uploaded successfully',
      status: 'payment_submitted'
    });

  } catch (error) {
    console.error('Error uploading receipt:', error);
    res.status(500).json({
      error: 'Upload failed',
      message: 'Unable to upload documents. Please try again.'
    });
  }
});

/**
 * POST /api/bookings/:id/stripe-payment
 * Handle Stripe payment confirmation (added for booking flow)
 */
router.post('/:id/stripe-payment', auth, async (req, res) => {
  const bookingId = req.params.id;
  const userId = req.user.id;
  const { payment_intent_id, payment_method_id } = req.body;

  try {
    // Verify booking belongs to user and is approved
    const booking = await query(
      'SELECT * FROM booking_requests WHERE id = ? AND user_id = ?',
      [bookingId, userId]
    );

    if (booking.length === 0) {
      return res.status(404).json({
        error: 'Booking not found'
      });
    }

    if (booking[0].status !== 'approved') {
      return res.status(400).json({
        error: 'Booking must be approved for payment'
      });
    }

    // Update booking with Stripe payment info
    await query(
      `UPDATE booking_requests 
       SET stripe_payment_intent_id = ?, stripe_payment_method_id = ?,
           payment_method = 'stripe', status = 'payment_submitted', payment_submitted_at = NOW()
       WHERE id = ?`,
      [payment_intent_id, payment_method_id, bookingId]
    );

    // Notify owner about Stripe payment
    await query(
      `INSERT INTO notifications (user_id, type, title, message, booking_id, from_user_id, data)
       VALUES (?, 'payment_submitted', 'Stripe Payment Received', 
               'A tenant has completed payment via Stripe for their booking.', ?, ?, ?)`,
      [
        booking[0].property_owner_id,
        bookingId,
        userId,
        JSON.stringify({ payment_intent_id, payment_method_id })
      ]
    );

    res.json({
      message: 'Stripe payment processed successfully',
      status: 'payment_submitted'
    });

  } catch (error) {
    console.error('Error processing Stripe payment:', error);
    res.status(500).json({
      error: 'Payment processing failed',
      message: 'Unable to process payment. Please try again.'
    });
  }
});

/**
 * POST /api/bookings/:id/confirm-booking
 * Owner confirms booking after payment review (added for booking flow)
 */
router.post('/:id/confirm-booking', auth, requirePropertyOwner, async (req, res) => {
  const bookingId = req.params.id;
  const ownerId = req.user.id;
  const { action, message } = req.body; // action: 'approve' or 'reject'

  if (!action || !['approve', 'reject'].includes(action)) {
    return res.status(400).json({
      error: 'Invalid action',
      message: 'Action must be approve or reject'
    });
  }

  try {
    // Verify booking belongs to owner and payment is submitted
    const booking = await query(
      'SELECT * FROM booking_requests WHERE id = ? AND property_owner_id = ?',
      [bookingId, ownerId]
    );

    if (booking.length === 0) {
      return res.status(404).json({
        error: 'Booking not found or access denied'
      });
    }

    if (booking[0].status !== 'payment_submitted') {
      return res.status(400).json({
        error: 'Booking must have payment submitted for confirmation'
      });
    }

    const newStatus = action === 'approve' ? 'confirmed' : 'payment_rejected';
    const responseMessage = message || (action === 'approve' ? 'Payment approved, booking confirmed' : 'Payment rejected');

    // Update booking status
    await query(
      `UPDATE booking_requests 
       SET status = ?, owner_response_message = ?, payment_confirmed_at = NOW()
       WHERE id = ?`,
      [newStatus, responseMessage, bookingId]
    );

    // Notify user about confirmation
    const notificationTitle = action === 'approve' ? 'Booking Confirmed!' : 'Payment Rejected';
    const notificationMessage = action === 'approve' 
      ? 'Your payment has been approved and booking is confirmed!'
      : `Your payment was rejected. ${responseMessage}`;

    await query(
      `INSERT INTO notifications (user_id, type, title, message, booking_id, from_user_id, data)
       VALUES (?, 'booking_confirmed', ?, ?, ?, ?, ?)`,
      [
        booking[0].user_id,
        notificationTitle,
        notificationMessage,
        bookingId,
        ownerId,
        JSON.stringify({ final_status: newStatus })
      ]
    );

    res.json({
      message: `Booking ${action === 'approve' ? 'confirmed' : 'payment rejected'} successfully`,
      booking_id: bookingId,
      status: newStatus
    });

  } catch (error) {
    console.error('Error confirming booking:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to confirm booking. Please try again.'
    });
  }
});

router.put('/:bookingId/respond', auth, async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { action, message = '', account_info = '' } = req.body;
    const ownerId = req.user.id;

    // Validate action
    if (!['approved', 'rejected'].includes(action)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid action',
        message: 'Action must be either "approved" or "rejected"'
      });
    }

    // Get booking and validate owner
    const booking = await query(
      'SELECT * FROM booking_requests WHERE id = ? AND property_owner_id = ?',
      [bookingId, ownerId]
    );

    if (booking.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Booking not found',
        message: 'Booking not found or access denied'
      });
    }

    const bookingData = booking[0];

    // Update booking status and add account info
    const newStatus = action === 'approved' ? 'approved' : 'rejected';
    await query(
      'UPDATE booking_requests SET status = ?, owner_response_message = ?, payment_account_info = ?, owner_responded_at = NOW() WHERE id = ?',
      [newStatus, message, account_info, bookingId]
    );

    if (action === 'approved') {
      // Create notification for user with account info
      await query(
        `INSERT INTO notifications (user_id, type, title, message, data, booking_id, property_id, from_user_id) 
         VALUES (?, 'booking_approved_payment', 'Booking Approved - Payment Required', 
         'Your booking has been approved! Please proceed with payment using the provided account details.', 
         ?, ?, ?, ?)`,
        [
          bookingData.user_id,
          JSON.stringify({
            booking_id: bookingId,
            account_info: account_info,
            amount: bookingData.advance_amount,
            property_address: bookingData.property_address || ''
          }),
          bookingId,
          bookingData.property_id,
          ownerId
        ]
      );
    } else {
      // Create rejection notification
      await query(
        `INSERT INTO notifications (user_id, type, title, message, data, booking_id, property_id, from_user_id) 
         VALUES (?, 'booking_response', 'Booking Rejected', ?, ?, ?, ?, ?)`,
        [
          bookingData.user_id,
          `Your booking request has been rejected. ${message}`,
          JSON.stringify({ action: 'rejected', reason: message }),
          bookingId,
          bookingData.property_id,
          ownerId
        ]
      );
    }

    res.json({
      success: true,
      message: `Booking ${action} successfully`,
      booking: bookingData
    });

  } catch (error) {
    console.error('Error responding to booking:', error);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: 'Failed to respond to booking request'
    });
  }
});

router.post('/:bookingId/payment-receipt', auth, upload.fields([
  { name: 'payment_receipt', maxCount: 1 },
  { name: 'nic_document', maxCount: 1 }
]), processFileUpload, async (req, res) => {
  try {
    const { bookingId } = req.params;
    const userId = req.user.id;

    // Validate booking belongs to user and is approved
    const booking = await query(
      'SELECT * FROM booking_requests WHERE id = ? AND user_id = ? AND status = "approved"',
      [bookingId, userId]
    );

    if (booking.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Booking not found',
        message: 'Booking not found or not approved for payment'
      });
    }

    const bookingData = booking[0];

    if (!req.uploadedFiles?.payment_receipt?.[0] || !req.uploadedFiles?.nic_document?.[0]) {
      return res.status(400).json({
        success: false,
        error: 'Missing files',
        message: 'Both payment receipt and NIC document are required'
      });
    }

    const receiptFile = req.uploadedFiles.payment_receipt[0];
    const nicFile = req.uploadedFiles.nic_document[0];

    // Update booking with payment proof
    await query(
      `UPDATE booking_requests SET 
       status = 'payment_submitted',
       payment_proof_url = ?,
       verification_document_url = ?,
       verification_document_type = 'NIC',
       payment_method = 'receipt_upload',
       payment_submitted_at = NOW()
       WHERE id = ?`,
      [receiptFile.url, nicFile.url, bookingId]
    );

    // Notify property owner about payment submission
    await query(
      `INSERT INTO notifications (user_id, type, title, message, data, booking_id, property_id, from_user_id) 
       VALUES (?, 'payment_submitted', 'Payment Receipt Submitted', 
       'A tenant has submitted payment receipt and verification documents for your property booking.', 
       ?, ?, ?, ?)`,
      [
        bookingData.property_owner_id,
        JSON.stringify({
          booking_id: bookingId,
          tenant_name: `${bookingData.first_name} ${bookingData.last_name}`,
          amount: bookingData.advance_amount,
          receipt_url: receiptFile.url,
          nic_url: nicFile.url
        }),
        bookingId,
        bookingData.property_id,
        userId
      ]
    );

    res.json({
      success: true,
      message: 'Payment receipt and documents uploaded successfully',
      data: {
        receipt_url: receiptFile.url,
        nic_url: nicFile.url,
        booking_status: 'payment_submitted'
      }
    });

  } catch (error) {
    console.error('Error uploading payment receipt:', error);
    res.status(500).json({
      success: false,
      error: 'Upload failed',
      message: 'Failed to upload payment documents'
    });
  }
});

router.put('/:bookingId/confirm-payment', auth, async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { action, message = '' } = req.body;
    const ownerId = req.user.id;

    if (!['approved', 'rejected'].includes(action)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid action',
        message: 'Action must be "approved" or "rejected"'
      });
    }

    // Get booking and validate
    const booking = await query(
      'SELECT * FROM booking_requests WHERE id = ? AND property_owner_id = ? AND status = "payment_submitted"',
      [bookingId, ownerId]
    );

    if (booking.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Booking not found',
        message: 'Booking not found or payment not submitted'
      });
    }

    const bookingData = booking[0];
    const newStatus = action === 'approved' ? 'confirmed' : 'payment_rejected';

    // Update booking status
    await query(
      'UPDATE booking_requests SET status = ?, payment_confirmed_at = NOW() WHERE id = ?',
      [newStatus, bookingId]
    );

    // Notify user about payment confirmation
    const notificationTitle = action === 'approved' ? 'Booking Confirmed!' : 'Payment Rejected';
    const notificationMessage = action === 'approved' 
      ? 'Your payment has been confirmed and your booking is now confirmed!'
      : `Your payment has been rejected. ${message}`;

    await query(
      `INSERT INTO notifications (user_id, type, title, message, data, booking_id, property_id, from_user_id) 
       VALUES (?, 'booking_confirmed', ?, ?, ?, ?, ?, ?)`,
      [
        bookingData.user_id,
        notificationTitle,
        notificationMessage,
        JSON.stringify({ action, message }),
        bookingId,
        bookingData.property_id,
        ownerId
      ]
    );

    res.json({
      success: true,
      message: `Payment ${action} successfully`,
      booking_status: newStatus
    });

  } catch (error) {
    console.error('Error confirming payment:', error);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: 'Failed to confirm payment'
    });
  }
});

router.get('/property/:propertyId/status', auth, async (req, res) => {
  try {
    const { propertyId } = req.params;
    
    // Get active bookings for this property
    const activeBookings = await query(
      `SELECT id, user_id, check_in_date, check_out_date, status 
       FROM booking_requests 
       WHERE property_id = ? AND status IN ('confirmed', 'payment_submitted') 
       AND check_out_date >= CURDATE()`,
      [propertyId]
    );

    res.json({
      success: true,
      active_bookings: activeBookings,
      is_available: activeBookings.length === 0
    });

  } catch (error) {
    console.error('Error checking property status:', error);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: 'Failed to check property status'
    });
  }
});

router.post('/:id/upload-documents', auth, (req, res, next) => {
  // Use existing upload middleware with field names for booking documents
  const uploadMiddleware = upload.uploadMultipleFiles;
  uploadMiddleware(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        error: 'Upload failed',
        message: err.message
      });
    }
    next();
  });
}, async (req, res) => {
  const bookingId = req.params.id;
  const userId = req.user.id;

  try {
    // Verify booking belongs to user
    const booking = await query(
      'SELECT * FROM booking_requests WHERE id = ? AND user_id = ?',
      [bookingId, userId]
    );

    if (booking.length === 0) {
      return res.status(404).json({
        error: 'Booking not found'
      });
    }

    if (!req.files || !req.files.paymentReceipt || !req.files.nicPhoto) {
      return res.status(400).json({
        error: 'Missing files',
        message: 'Both payment receipt and NIC photo are required'
      });
    }

    const paymentReceipt = req.files.paymentReceipt[0];
    const nicPhoto = req.files.nicPhoto[0];

    // Update booking with uploaded file URLs (from existing upload processing)
    await query(
      `UPDATE booking_requests 
       SET payment_proof_url = ?, 
           verification_document_url = ?, 
           verification_document_type = 'NIC',
           payment_method = 'receipt_upload',
           status = 'payment_submitted',
           payment_submitted_at = NOW()
       WHERE id = ?`,
      [paymentReceipt.url, nicPhoto.url, bookingId]
    );

    // Notify property owner
    const bookingData = booking[0];
    await query(
      `INSERT INTO notifications (user_id, type, title, message, booking_id, from_user_id, data)
       VALUES (?, 'payment_submitted', 'Payment Documents Uploaded', 
               'A tenant has uploaded payment receipt and verification documents.', ?, ?, ?)`,
      [
        bookingData.property_owner_id,
        bookingId,
        userId,
        JSON.stringify({
          payment_receipt: paymentReceipt.filename,
          nic_document: nicPhoto.filename
        })
      ]
    );

    res.json({
      success: true,
      message: 'Documents uploaded successfully',
      files: {
        payment_receipt: {
          url: paymentReceipt.url,
          filename: paymentReceipt.filename,
          originalname: paymentReceipt.originalname
        },
        nic_photo: {
          url: nicPhoto.url, 
          filename: nicPhoto.filename,
          originalname: nicPhoto.originalname
        }
      },
      booking_status: 'payment_submitted'
    });

  } catch (error) {
    console.error('Document upload error:', error);
    res.status(500).json({
      error: 'Upload failed',
      message: 'Failed to upload documents. Please try again.'
    });
  }
});


module.exports = router;