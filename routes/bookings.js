const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const db = require('../config/db');
const { upload, uploadToCloudinary } = require('../middleware/upload');

/**
 * POST /api/bookings/request
 * Submit a new booking request
 * User submits personal details and booking dates
 */
router.post('/request', auth, (req, res) => {
  const user_id = req.user.id;
  
  const {
    property_id,
    first_name,
    last_name,
    email,
    country_code,
    mobile_number,
    birthdate,
    gender,
    nationality,
    occupation,
    field,
    destination,
    relocation_details,
    check_in_date,
    check_out_date
  } = req.body;

  // Validate required fields
  if (!property_id || !first_name || !last_name || !email || !mobile_number || 
      !check_in_date || !check_out_date || !occupation || !field) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      required: ['property_id', 'first_name', 'last_name', 'email', 'mobile_number', 
                'check_in_date', 'check_out_date', 'occupation', 'field']
    });
  }

  // Validate dates
  const checkIn = new Date(check_in_date);
  const checkOut = new Date(check_out_date);
  const today = new Date();
  
  if (checkIn <= today) {
    return res.status(400).json({ error: 'Check-in date must be in the future' });
  }
  
  if (checkOut <= checkIn) {
    return res.status(400).json({ error: 'Check-out date must be after check-in date' });
  }

  // Get property details and owner info
  const getPropertyQuery = `
    SELECT ap.*, u.id as owner_id, ap.price
    FROM all_properties ap
    JOIN users u ON ap.user_id = u.id
    WHERE ap.id = ? AND ap.is_active = 1
  `;

  db.query(getPropertyQuery, [property_id], (err, propertyResults) => {
    if (err) {
      console.error('Error fetching property:', err);
      return res.status(500).json({ error: 'Error fetching property details' });
    }

    if (propertyResults.length === 0) {
      return res.status(404).json({ error: 'Property not found or not available' });
    }

    const property = propertyResults[0];
    
    // Calculate total price
    const days = Math.ceil((checkOut - checkIn) / (1000 * 60 * 60 * 24));
    const total_price = property.price;
    const service_fee = 300.00;

    // Check for existing pending request
    const checkExistingQuery = `
      SELECT id FROM booking_requests 
      WHERE user_id = ? AND property_id = ? AND status IN ('pending', 'approved', 'payment_submitted')
    `;

    db.query(checkExistingQuery, [user_id, property_id], (err, existingResults) => {
      if (err) {
        console.error('Error checking existing requests:', err);
        return res.status(500).json({ error: 'Error checking existing requests' });
      }

      if (existingResults.length > 0) {
        return res.status(409).json({ 
          error: 'You already have a pending booking request for this property' 
        });
      }

      // Insert the booking request
      const insertQuery = `
        INSERT INTO booking_requests (
          user_id, property_id, property_owner_id,
          first_name, last_name, email, country_code, mobile_number,
          birthdate, gender, nationality, occupation, field,
          destination, relocation_details,
          check_in_date, check_out_date, total_price, service_fee
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const values = [
        user_id, property_id, property.owner_id,
        first_name, last_name, email, country_code, mobile_number,
        birthdate, gender, nationality, occupation, field,
        destination, relocation_details,
        check_in_date, check_out_date, total_price, service_fee
      ];

      db.query(insertQuery, values, (err, results) => {
        if (err) {
          console.error('Error creating booking request:', err);
          return res.status(500).json({ error: 'Error creating booking request' });
        }

        res.status(201).json({
          message: 'Booking request submitted successfully',
          booking_id: results.insertId,
          status: 'pending',
          next_step: 'Wait for property owner to review your request'
        });
      });
    });
  });
});

/**
 * GET /api/bookings/user
 * Get all booking requests for the current user
 */
router.get('/user', auth, (req, res) => {
  const user_id = req.user.id;

  const query = `
    SELECT br.*, ap.property_type, ap.unit_type, ap.address,
           u.username as owner_username
    FROM booking_requests br
    JOIN all_properties ap ON br.property_id = ap.id
    JOIN users u ON br.property_owner_id = u.id
    WHERE br.user_id = ?
    ORDER BY br.created_at DESC
  `;

  db.query(query, [user_id], (err, results) => {
    if (err) {
      console.error('Error fetching user bookings:', err);
      return res.status(500).json({ error: 'Error fetching booking requests' });
    }

    res.json(results);
  });
});

/**
 * GET /api/bookings/owner
 * Get all booking requests for properties owned by the current user
 */
router.get('/owner', auth, (req, res) => {
  const owner_id = req.user.id;

  const query = `
    SELECT br.*, ap.property_type, ap.unit_type, ap.address,
           u.username as tenant_username
    FROM booking_requests br
    JOIN all_properties ap ON br.property_id = ap.id
    JOIN users u ON br.user_id = u.id
    WHERE br.property_owner_id = ?
    ORDER BY br.created_at DESC
  `;

  db.query(query, [owner_id], (err, results) => {
    if (err) {
      console.error('Error fetching owner bookings:', err);
      return res.status(500).json({ error: 'Error fetching booking requests' });
    }

    res.json(results);
  });
});

/**
 * PUT /api/bookings/respond/:id
 * Property owner responds to booking request (approve/reject)
 */
router.put('/respond/:id', auth, (req, res) => {
  const request_id = req.params.id;
  const owner_id = req.user.id;
  const { action, message, payment_account_info } = req.body;

  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Action must be either "approve" or "reject"' });
  }

  if (action === 'approve' && !payment_account_info) {
    return res.status(400).json({ error: 'Payment account information is required for approval' });
  }

  // Verify ownership and status
  const checkQuery = `
    SELECT * FROM booking_requests 
    WHERE id = ? AND property_owner_id = ? AND status = 'pending'
  `;

  db.query(checkQuery, [request_id, owner_id], (err, results) => {
    if (err) {
      console.error('Error checking booking request:', err);
      return res.status(500).json({ error: 'Error checking booking request' });
    }

    if (results.length === 0) {
      return res.status(404).json({ 
        error: 'Booking request not found, not owned by you, or not in pending status' 
      });
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    
    const updateQuery = `
      UPDATE booking_requests 
      SET status = ?, 
          owner_response_message = ?, 
          payment_account_info = ?,
          owner_responded_at = NOW(),
          updated_at = NOW()
      WHERE id = ?
    `;

    const values = [
      newStatus,
      message || null,
      action === 'approve' ? payment_account_info : null,
      request_id
    ];

    db.query(updateQuery, values, (err) => {
      if (err) {
        console.error('Error updating booking request:', err);
        return res.status(500).json({ error: 'Error updating booking request' });
      }

      res.json({
        message: `Booking request ${action}d successfully`,
        status: newStatus,
        next_step: action === 'approve' 
          ? 'Tenant can now submit payment and documents' 
          : 'Request has been rejected'
      });
    });
  });
});

/**
 * PUT /api/bookings/submit-payment/:id
 * User submits payment proof and verification documents
 */
router.put('/submit-payment/:id', auth, upload.fields([
  { name: 'payment_proof', maxCount: 1 },
  { name: 'verification_document', maxCount: 1 }
]), async (req, res) => {
  const request_id = req.params.id;
  const user_id = req.user.id;
  const { verification_document_type } = req.body;

  if (!req.files || !req.files.payment_proof || !req.files.verification_document) {
    return res.status(400).json({ 
      error: 'Both payment proof and verification document are required' 
    });
  }

  if (!verification_document_type) {
    return res.status(400).json({ error: 'Verification document type is required' });
  }

  try {
    // Verify request ownership and status
    const checkQuery = `
      SELECT * FROM booking_requests 
      WHERE id = ? AND user_id = ? AND status = 'approved'
    `;

    db.query(checkQuery, [request_id, user_id], async (err, results) => {
      if (err) {
        console.error('Error checking booking request:', err);
        return res.status(500).json({ error: 'Error checking booking request' });
      }

      if (results.length === 0) {
        return res.status(404).json({ 
          error: 'Booking request not found, not owned by you, or not in approved status' 
        });
      }

      try {
        // Upload files to cloud storage
        const paymentProofResult = await uploadToCloudinary(
          req.files.payment_proof[0].buffer, 
          req.files.payment_proof[0].originalname
        );
        
        const verificationDocResult = await uploadToCloudinary(
          req.files.verification_document[0].buffer, 
          req.files.verification_document[0].originalname
        );

        // Update booking request with file URLs
        const updateQuery = `
          UPDATE booking_requests 
          SET status = 'payment_submitted',
              payment_proof_url = ?,
              verification_document_type = ?,
              verification_document_url = ?,
              payment_submitted_at = NOW(),
              updated_at = NOW()
          WHERE id = ?
        `;

        const values = [
          paymentProofResult.secure_url,
          verification_document_type,
          verificationDocResult.secure_url,
          request_id
        ];

        db.query(updateQuery, values, (err) => {
          if (err) {
            console.error('Error updating booking request with payment:', err);
            return res.status(500).json({ error: 'Error submitting payment information' });
          }

          res.json({
            message: 'Payment and documents submitted successfully',
            status: 'payment_submitted',
            next_step: 'Wait for property owner to verify and confirm booking'
          });
        });

      } catch (uploadError) {
        console.error('Error uploading files:', uploadError);
        res.status(500).json({ error: 'Error uploading files' });
      }
    });

  } catch (error) {
    console.error('Error in payment submission:', error);
    res.status(500).json({ error: 'Error processing payment submission' });
  }
});

/**
 * PUT /api/bookings/confirm/:id
 * Property owner confirms booking after verifying payment
 */
router.put('/confirm/:id', auth, (req, res) => {
  const request_id = req.params.id;
  const owner_id = req.user.id;
  const { action, message } = req.body;

  if (!['confirm', 'reject_payment'].includes(action)) {
    return res.status(400).json({ error: 'Action must be either "confirm" or "reject_payment"' });
  }

  // Verify ownership and status
  const checkQuery = `
    SELECT * FROM booking_requests 
    WHERE id = ? AND property_owner_id = ? AND status = 'payment_submitted'
  `;

  db.query(checkQuery, [request_id, owner_id], (err, results) => {
    if (err) {
      console.error('Error checking booking request:', err);
      return res.status(500).json({ error: 'Error checking booking request' });
    }

    if (results.length === 0) {
      return res.status(404).json({ 
        error: 'Booking request not found, not owned by you, or not in payment_submitted status' 
      });
    }

    const newStatus = action === 'confirm' ? 'confirmed' : 'approved';
    
    const updateQuery = `
      UPDATE booking_requests 
      SET status = ?, 
          owner_response_message = ?, 
          confirmed_at = ${action === 'confirm' ? 'NOW()' : 'NULL'},
          updated_at = NOW()
      WHERE id = ?
    `;

    const values = [newStatus, message || null, request_id];

    db.query(updateQuery, values, (err) => {
      if (err) {
        console.error('Error updating booking confirmation:', err);
        return res.status(500).json({ error: 'Error updating booking status' });
      }

      res.json({
        message: `Booking ${action === 'confirm' ? 'confirmed' : 'payment rejected'} successfully`,
        status: newStatus,
        next_step: action === 'confirm' 
          ? 'Booking is now confirmed' 
          : 'Tenant needs to resubmit payment'
      });
    });
  });
});

/**
 * GET /api/bookings/:id
 * Get specific booking details
 */
router.get('/:id', auth, (req, res) => {
  const booking_id = req.params.id;
  const user_id = req.user.id;

  const query = `
    SELECT br.*, ap.property_type, ap.unit_type, ap.address,
           owner.username as owner_username,
           tenant.username as tenant_username
    FROM booking_requests br
    JOIN all_properties ap ON br.property_id = ap.id
    JOIN users owner ON br.property_owner_id = owner.id
    JOIN users tenant ON br.user_id = tenant.id
    WHERE br.id = ? AND (br.user_id = ? OR br.property_owner_id = ?)
  `;

  db.query(query, [booking_id, user_id, user_id], (err, results) => {
    if (err) {
      console.error('Error fetching booking details:', err);
      return res.status(500).json({ error: 'Error fetching booking details' });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: 'Booking not found or access denied' });
    }

    res.json(results[0]);
  });
});

/**
 * DELETE /api/bookings/:id
 * Cancel a booking request (only if status is pending)
 */
router.delete('/:id', auth, (req, res) => {
  const booking_id = req.params.id;
  const user_id = req.user.id;

  // Check if booking exists and belongs to user and is cancellable
  const checkQuery = `
    SELECT * FROM booking_requests 
    WHERE id = ? AND user_id = ? AND status IN ('pending', 'approved')
  `;

  db.query(checkQuery, [booking_id, user_id], (err, results) => {
    if (err) {
      console.error('Error checking booking for cancellation:', err);
      return res.status(500).json({ error: 'Error checking booking' });
    }

    if (results.length === 0) {
      return res.status(404).json({ 
        error: 'Booking not found, not owned by you, or cannot be cancelled' 
      });
    }

    // Update status to cancelled
    const updateQuery = `
      UPDATE booking_requests 
      SET status = 'cancelled', updated_at = NOW()
      WHERE id = ?
    `;

    db.query(updateQuery, [booking_id], (err) => {
      if (err) {
        console.error('Error cancelling booking:', err);
        return res.status(500).json({ error: 'Error cancelling booking' });
      }

      res.json({ message: 'Booking cancelled successfully' });
    });
  });
});

module.exports = router;