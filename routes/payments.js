const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { auth } = require('../middleware/auth');
const { query } = require('../config/db');

router.post('/create-payment-intent', auth, async (req, res) => {
  try {
    const { booking_id, amount, payment_method_id } = req.body;
    const userId = req.user.id;

    if (!booking_id || !amount || !payment_method_id) {
      return res.status(400).json({
        error: 'booking_id, amount, and payment_method_id are required'
      });
    }

    if (amount < 50) {
      return res.status(400).json({
        error: 'Amount must be at least 50 cents'
      });
    }

    const booking = await query(
      'SELECT id, user_id, property_id, status, advance_amount FROM booking_requests WHERE id = ? AND user_id = ?',
      [booking_id, userId]
    );

    if (booking.length === 0) {
      return res.status(404).json({
        error: 'Booking not found or does not belong to you'
      });
    }

    if (booking[0].status !== 'approved') {
      return res.status(400).json({
        error: 'Booking must be approved before payment'
      });
    }

    const expectedAmount = Math.round(booking[0].advance_amount * 100);
    if (amount !== expectedAmount) {
      return res.status(400).json({
        error: `Expected amount: ${expectedAmount} cents, received: ${amount} cents`
      });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,
      currency: 'lkr',
      payment_method: payment_method_id,
      confirmation_method: 'manual',
      confirm: true,
      return_url: `${process.env.CLIENT_URL}/booking-success`,
      metadata: {
        booking_id: booking_id.toString(),
        user_id: userId.toString(),
        property_id: booking[0].property_id.toString()
      }
    });

    res.json({
      client_secret: paymentIntent.client_secret,
      status: paymentIntent.status
    });

  } catch (error) {
    console.error('Error creating payment intent:', error);
    
    if (error.type === 'StripeCardError') {
      res.status(400).json({
        error: 'Card error',
        message: error.message
      });
    } else if (error.type === 'StripeRateLimitError') {
      res.status(429).json({
        error: 'Too many requests. Please try again later.'
      });
    } else if (error.type === 'StripeInvalidRequestError') {
      res.status(400).json({
        error: 'Invalid request',
        message: error.message
      });
    } else if (error.type === 'StripeAPIError') {
      res.status(500).json({
        error: 'Payment processing is temporarily unavailable'
      });
    } else {
      res.status(500).json({
        error: 'Unable to process payment'
      });
    }
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