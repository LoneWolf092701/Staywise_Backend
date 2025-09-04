const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { auth } = require('../middleware/auth');
const { query } = require('../config/db');
const { createPaymentIntent, verifyPayment } = require('../utils/paymentGateway');


router.post('/create-payment-intent', auth, async (req, res) => {
  try {
    const { booking_id, amount, payment_method_id } = req.body;
    const userId = req.user.id;

    if (!booking_id || !amount) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'Booking ID and amount are required'
      });
    }

    // Verify booking belongs to user
    const booking = await query(
      'SELECT * FROM booking_requests WHERE id = ? AND user_id = ?',
      [booking_id, userId]
    );

    if (booking.length === 0) {
      return res.status(404).json({
        error: 'Booking not found'
      });
    }

    const bookingData = booking[0];
    const result = await createPaymentIntent(amount, booking_id, bookingData.email);

    if (!result.success) {
      return res.status(500).json({
        error: 'Payment intent creation failed',
        message: result.error
      });
    }

    res.json({
      client_secret: result.client_secret,
      payment_intent_id: result.payment_intent_id
    });

  } catch (error) {
    console.error('Create payment intent error:', error);
    res.status(500).json({
      error: 'Payment processing failed'
    });
  }
});

// Verify Stripe payment
router.post('/verify-stripe-payment', auth, async (req, res) => {
  try {
    const { payment_intent_id } = req.body;

    if (!payment_intent_id) {
      return res.status(400).json({
        error: 'Payment intent ID required'
      });
    }

    const result = await verifyPayment(payment_intent_id);

    if (!result.success) {
      return res.status(400).json({
        error: 'Payment verification failed',
        message: result.error
      });
    }

    res.json({
      success: true,
      status: result.status,
      amount: result.amount
    });

  } catch (error) {
    console.error('Verify payment error:', error);
    res.status(500).json({
      error: 'Payment verification failed'
    });
  }
});

router.get('/booking/:booking_id/status', auth, async (req, res) => {
  try {
    const bookingId = req.params.booking_id;
    const userId = req.user.id;

    const booking = await query(
      `SELECT 
         payment_method,
         status,
         stripe_payment_intent_id,
         payment_submitted_at,
         payment_confirmed_at
       FROM booking_requests 
       WHERE id = ? AND (user_id = ? OR property_owner_id = ?)`,
      [bookingId, userId, userId]
    );

    if (booking.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const bookingData = booking[0];
    let paymentStatus = {
      payment_method: bookingData.payment_method,
      booking_status: bookingData.status,
      payment_submitted_at: bookingData.payment_submitted_at,
      payment_confirmed_at: bookingData.payment_confirmed_at
    };

    if (bookingData.stripe_payment_intent_id) {
      try {
        const paymentIntent = await stripe.paymentIntents.retrieve(bookingData.stripe_payment_intent_id);
        paymentStatus.stripe_status = paymentIntent.status;
        paymentStatus.stripe_amount = paymentIntent.amount;
        paymentStatus.stripe_currency = paymentIntent.currency;
      } catch (stripeError) {
        console.error('Error retrieving payment intent:', stripeError);
      }
    }

    res.json(paymentStatus);

  } catch (error) {
    console.error('Error getting payment status:', error);
    res.status(500).json({ error: 'Unable to retrieve payment status' });
  }
});

module.exports = router;