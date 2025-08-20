const express = require('express');
const router = express.Router();
const { query, executeTransaction } = require('../config/db');
const { auth, requireUser, requirePropertyOwner } = require('../middleware/auth');

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
      WHERE id = ? AND is_active = 1 AND approval_status = 'approved'
    `;
    const properties = await query(propertyQuery, [property_id]);

    if (properties.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'The selected property is not available for booking'
      });
    }

    const property = properties[0];

    if (property.user_id === userId) {
      return res.status(400).json({
        error: 'Invalid booking',
        message: 'You cannot book your own property'
      });
    }

    const timeDifference = checkOutDate.getTime() - checkInDate.getTime();
    const bookingDays = Math.ceil(timeDifference / (1000 * 3600 * 24));
    const bookingMonths = Math.ceil(bookingDays / 30);
    
    const monthlyPrice = parseFloat(property.price);
    const totalPrice = monthlyPrice * bookingMonths;
    const serviceFee = 300.00;
    const advanceAmount = totalPrice * 0.30;

    const overlapQuery = `
      SELECT COUNT(*) as count 
      FROM booking_requests 
      WHERE property_id = ? 
      AND status IN ('approved', 'confirmed', 'payment_submitted')
      AND (
        (check_in_date <= ? AND check_out_date > ?) OR
        (check_in_date < ? AND check_out_date >= ?) OR
        (check_in_date >= ? AND check_out_date <= ?)
      )
    `;
    
    const overlapResult = await query(overlapQuery, [
      property_id, check_in_date, check_in_date, check_out_date, check_out_date, 
      check_in_date, check_out_date
    ]);

    if (overlapResult[0].count > 0) {
      return res.status(409).json({
        error: 'Booking conflict',
        message: 'Property is not available for the selected dates'
      });
    }

    const insertQuery = `
      INSERT INTO booking_requests (
        user_id, property_id, property_owner_id, first_name, last_name, email,
        country_code, mobile_number, birthdate, gender, nationality, occupation,
        field, destination, relocation_details, check_in_date, check_out_date,
        total_price, service_fee, advance_amount, booking_days, booking_months
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const insertResult = await query(insertQuery, [
      userId, property_id, property.user_id, first_name, last_name, email,
      country_code, mobile_number, birthdate || null, gender || null, 
      nationality || null, occupation || null, field || null, 
      destination || null, relocation_details || null, check_in_date, 
      check_out_date, totalPrice, serviceFee, advanceAmount, bookingDays, bookingMonths
    ]);

    const bookingId = insertResult.insertId;

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
      },
      filters: {
        status: status || null
      }
    });

  } catch (error) {
    console.error('Error fetching user bookings:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch your bookings. Please try again.'
    });
  }
});

/**
 * GET /api/bookings/owner
 * Get booking requests for property owner's properties (property owners only)
 */
router.get('/owner', auth, requirePropertyOwner, async (req, res) => {
  const ownerId = req.user.id;
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const offset = (page - 1) * limit;
  const status = req.query.status;
  const propertyId = req.query.property_id;

  try {
    let whereClause = 'WHERE br.property_owner_id = ?';
    let queryParams = [ownerId];

    if (status && ['pending', 'approved', 'rejected', 'cancelled'].includes(status)) {
      whereClause += ' AND br.status = ?';
      queryParams.push(status);
    }

    if (propertyId && !isNaN(propertyId)) {
      whereClause += ' AND br.property_id = ?';
      queryParams.push(parseInt(propertyId));
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
      },
      filters: {
        status: status || null,
        property_id: propertyId || null
      }
    });

  } catch (error) {
    console.error('Error fetching owner bookings:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to fetch booking requests. Please try again.'
    });
  }
});

/**
 * GET /api/bookings/:id
 * Get a specific booking by ID (user or property owner can access)
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

    // Check permissions based on status change
    let canUpdate = false;
    let validTransition = false;

    if (status === 'cancelled' && booking.user_id === userId) {
      // Users can cancel their own bookings
      canUpdate = true;
      validTransition = ['pending', 'approved'].includes(booking.status);
    } else if (['approved', 'rejected'].includes(status) && booking.property_owner_id === userId) {
      // Property owners can approve/reject bookings
      canUpdate = true;
      validTransition = booking.status === 'pending';
    } else if (userRole === 'admin') {
      // Admins can update any booking
      canUpdate = true;
      validTransition = true;
    }

    if (!canUpdate) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You do not have permission to update this booking'
      });
    }

    if (!validTransition) {
      return res.status(400).json({
        error: 'Invalid status transition',
        message: `Cannot change status from ${booking.status} to ${status}`
      });
    }

    // Update booking status
    await query(
      'UPDATE booking_requests SET status = ?, status_message = ?, updated_at = NOW() WHERE id = ?',
      [status, statusMessage || null, bookingId]
    );

    // Get updated booking info
    const updatedBooking = await query(`
      SELECT 
        br.id, br.status, br.status_message, br.updated_at,
        ap.property_type, ap.address as property_address,
        tenant.username as tenant_username, tenant.email as tenant_email,
        owner.username as owner_username
      FROM booking_requests br
      INNER JOIN all_properties ap ON br.property_id = ap.id
      INNER JOIN users tenant ON br.user_id = tenant.id
      INNER JOIN users owner ON br.property_owner_id = owner.id
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
            return res.status(400).json({
              error: 'Invalid email',
              message: 'Please provide a valid email address'
            });
          }
        }
        
        if (['adults', 'children', 'pets'].includes(field)) {
          const num = parseInt(updateData[field]);
          if (isNaN(num) || num < 0) {
            return res.status(400).json({
              error: `Invalid ${field}`,
              message: `${field} must be a non-negative number`
            });
          }
          updateFields[field] = num;
        } else {
          updateFields[field] = updateData[field];
        }
      }
    });

    if (Object.keys(updateFields).length === 0) {
      return res.status(400).json({
        error: 'No valid fields to update',
        message: 'Please provide at least one field to update'
      });
    }

    // Execute update
    const updateKeys = Object.keys(updateFields);
    const updateValues = Object.values(updateFields);
    const setClause = updateKeys.map(key => `${key} = ?`).join(', ');

    await query(
      `UPDATE booking_requests SET ${setClause}, updated_at = NOW() WHERE id = ?`,
      [...updateValues, bookingId]
    );

    // Return updated booking
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
      message: 'Unable to update booking. Please try again.'
    });
  }
});

/**
 * DELETE /api/bookings/:id
 * Delete a booking request (users can delete their own cancelled bookings)
 */
router.delete('/:id', auth, async (req, res) => {
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
    const existingBooking = await query(
      'SELECT id, user_id, status, property_id FROM booking_requests WHERE id = ?',
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
    const canDelete = userRole === 'admin' || 
                     (booking.user_id === userId && booking.status === 'cancelled');

    if (!canDelete) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You can only delete your own cancelled bookings'
      });
    }

    await query('DELETE FROM booking_requests WHERE id = ?', [bookingId]);

    res.json({
      message: 'Booking deleted successfully',
      booking_id: parseInt(bookingId)
    });

  } catch (error) {
    console.error('Error deleting booking:', error);
    res.status(500).json({
      error: 'Database error',
      message: 'Unable to delete booking. Please try again.'
    });
  }
});

module.exports = router;