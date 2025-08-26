const express = require('express');
const router = express.Router();
const { query, executeTransaction } = require('../config/db');
const { auth, requireUser, requirePropertyOwner } = require('../middleware/auth');
const { createNotification } = require('./notifications');

/**
 * Safe JSON parsing function that handles both JSON and comma-separated string formats
 * This ensures booking operations can display property information regardless of storage format
 * @param {string|null} value - The value to parse (JSON string or comma-separated string)
 * @returns {Array} Array of parsed values
 */
const safeJsonParse = (value) => {
  if (!value) return [];
  
  // If already an array, return it
  if (Array.isArray(value)) return value;
  
  // If it's a string, try to parse as JSON first
  if (typeof value === 'string') {
    // Try JSON parsing first
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
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

module.exports = router;