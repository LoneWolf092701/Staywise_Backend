const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { auth } = require('../middleware/auth');
const { query } = require('../config/db');
const { createPaymentIntent, confirmPaymentIntent, verifyPayment } = require('../utils/paymentGateway');

// Webhook endpoint for Stripe events
router.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  try {
    switch (event.type) {
      case 'payment_intent.succeeded':
        await handlePaymentSuccess(event.data.object);
        break;
      case 'payment_intent.payment_failed':
        await handlePaymentFailure(event.data.object);
        break;
      case 'payment_intent.canceled':
        await handlePaymentCanceled(event.data.object);
        break;
      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    res.json({received: true});
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({error: 'Webhook processing failed'});
  }
});

// Handle successful payment
async function handlePaymentSuccess(paymentIntent) {
  try {
    const { id: paymentIntentId, metadata, amount } = paymentIntent;
    const bookingId = metadata.booking_id;

    if (!bookingId) {
      console.error('No booking_id found in payment intent metadata');
      return;
    }

    // Update booking with payment confirmation
    await query(
      `UPDATE booking_requests 
       SET payment_status = 'confirmed', 
           payment_confirmed_at = NOW(),
           stripe_payment_intent_id = ?,
           payment_amount = ?
       WHERE id = ?`,
      [paymentIntentId, amount / 100, bookingId]
    );

    // Get booking details for notification
    const booking = await query(
      `SELECT br.*, p.title as property_title, p.property_owner_id 
       FROM booking_requests br 
       JOIN properties p ON br.property_id = p.id 
       WHERE br.id = ?`,
      [bookingId]
    );

    if (booking.length > 0) {
      const bookingData = booking[0];
      
      // Send confirmation email to user
      // You can add email notification here if needed
      console.log(`Payment confirmed for booking ${bookingId}: ${bookingData.property_title}`);
      
      // Update property owner notification
      await query(
        `INSERT INTO notifications (user_id, type, title, message, booking_id, created_at) 
         VALUES (?, 'payment_confirmed', 'Payment Confirmed', 
                 'Payment has been confirmed for booking at ${bookingData.property_title}', 
                 ?, NOW())`,
        [bookingData.property_owner_id, bookingId]
      );
    }

    console.log(`Payment intent ${paymentIntentId} succeeded for booking ${bookingId}`);
  } catch (error) {
    console.error('Error handling payment success:', error);
  }
}

// Handle failed payment
async function handlePaymentFailure(paymentIntent) {
  try {
    const { id: paymentIntentId, metadata, last_payment_error } = paymentIntent;
    const bookingId = metadata.booking_id;

    if (!bookingId) {
      console.error('No booking_id found in payment intent metadata');
      return;
    }

    // Update booking with payment failure
    await query(
      `UPDATE booking_requests 
       SET payment_status = 'failed', 
           payment_failed_at = NOW(),
           stripe_payment_intent_id = ?,
           payment_error_message = ?
       WHERE id = ?`,
      [paymentIntentId, last_payment_error?.message || 'Payment failed', bookingId]
    );

    // Get booking details for notification
    const booking = await query(
      `SELECT br.*, p.title as property_title, br.user_id 
       FROM booking_requests br 
       JOIN properties p ON br.property_id = p.id 
       WHERE br.id = ?`,
      [bookingId]
    );

    if (booking.length > 0) {
      const bookingData = booking[0];
      
      // Send failure notification to user
      await query(
        `INSERT INTO notifications (user_id, type, title, message, booking_id, created_at) 
         VALUES (?, 'payment_failed', 'Payment Failed', 
                 'Your payment for booking at ${bookingData.property_title} has failed. Please try again.', 
                 ?, NOW())`,
        [bookingData.user_id, bookingId]
      );
    }

    console.log(`Payment intent ${paymentIntentId} failed for booking ${bookingId}`);
  } catch (error) {
    console.error('Error handling payment failure:', error);
  }
}

// Handle canceled payment
async function handlePaymentCanceled(paymentIntent) {
  try {
    const { id: paymentIntentId, metadata } = paymentIntent;
    const bookingId = metadata.booking_id;

    if (!bookingId) {
      console.error('No booking_id found in payment intent metadata');
      return;
    }

    // Update booking with payment cancellation
    await query(
      `UPDATE booking_requests 
       SET payment_status = 'canceled', 
           payment_canceled_at = NOW(),
           stripe_payment_intent_id = ?
       WHERE id = ?`,
      [paymentIntentId, bookingId]
    );

    console.log(`Payment intent ${paymentIntentId} canceled for booking ${bookingId}`);
  } catch (error) {
    console.error('Error handling payment cancellation:', error);
  }
}

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
    const result = await createPaymentIntent(amount, booking_id, bookingData.email, payment_method_id);

    if (!result.success) {
      // Check if it's specifically an API key error
      if (result.error === 'STRIPE_API_KEY_ERROR') {
        return res.status(400).json({
          error: 'STRIPE_API_KEY_ERROR',
          message: 'Payment service temporarily unavailable'
        });
      }
      
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

// Confirm payment intent
router.post('/confirm-payment-intent', auth, async (req, res) => {
  try {
    const { payment_intent_id, payment_method_id } = req.body;

    if (!payment_intent_id || !payment_method_id) {
      return res.status(400).json({
        error: 'Payment intent ID and payment method ID are required'
      });
    }

    const result = await confirmPaymentIntent(payment_intent_id, payment_method_id);

    if (!result.success) {
      return res.status(400).json({
        error: 'Payment confirmation failed',
        message: result.error
      });
    }

    res.json({
      success: true,
      status: result.status,
      amount: result.amount,
      payment_intent: result.payment_intent
    });

  } catch (error) {
    console.error('Confirm payment intent error:', error);
    res.status(500).json({
      error: 'Payment confirmation failed'
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

// Get payment confirmation details
router.get('/confirmation/:payment_intent_id', auth, async (req, res) => {
  try {
    const { payment_intent_id } = req.params;
    const userId = req.user.id;

    // Get booking details with payment info
    const booking = await query(
      `SELECT 
         br.*,
         p.title as property_title,
         p.address,
         p.images,
         u.first_name,
         u.last_name,
         u.email
       FROM booking_requests br
       JOIN properties p ON br.property_id = p.id
       JOIN users u ON br.user_id = u.id
       WHERE br.stripe_payment_intent_id = ? AND br.user_id = ?`,
      [payment_intent_id, userId]
    );

    if (booking.length === 0) {
      return res.status(404).json({ error: 'Payment confirmation not found' });
    }

    const bookingData = booking[0];

    // Get Stripe payment details
    let stripePayment = null;
    try {
      const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);
      stripePayment = {
        id: paymentIntent.id,
        status: paymentIntent.status,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
        created: paymentIntent.created,
        payment_method: paymentIntent.payment_method,
        charges: paymentIntent.charges?.data || []
      };
    } catch (stripeError) {
      console.error('Error retrieving payment intent:', stripeError);
    }

    res.json({
      booking: {
        id: bookingData.id,
        property_title: bookingData.property_title,
        address: bookingData.address,
        images: bookingData.images,
        check_in: bookingData.check_in,
        check_out: bookingData.check_out,
        guest_name: bookingData.guest_name,
        guest_email: bookingData.email,
        advance_amount: bookingData.advance_amount,
        total_amount: bookingData.total_amount,
        status: bookingData.status,
        payment_status: bookingData.payment_status,
        payment_confirmed_at: bookingData.payment_confirmed_at
      },
      payment: stripePayment
    });

  } catch (error) {
    console.error('Error getting payment confirmation:', error);
    res.status(500).json({ error: 'Unable to retrieve payment confirmation' });
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