const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

/**
 * Create Stripe payment intent for booking
 */
async function createPaymentIntent(amount, bookingId, userEmail, paymentMethodId = null) {
  try {
    const paymentIntentData = {
      amount: Math.round(amount), // Amount is already in cents from frontend
      currency: 'usd', // Match frontend currency
      metadata: {
        booking_id: bookingId.toString(),
        type: 'booking_advance_payment'
      },
      receipt_email: userEmail
    };

    // If payment method is provided, attach it and use automatic confirmation
    // Otherwise, use automatic payment methods
    if (paymentMethodId) {
      paymentIntentData.payment_method = paymentMethodId;
      paymentIntentData.confirmation_method = 'automatic';
      // Don't set confirm = true here, let frontend handle confirmation
    } else {
      // Use automatic payment methods when no specific payment method is provided
      paymentIntentData.automatic_payment_methods = {
        enabled: true,
        allow_redirects: 'never'
      };
    }

    const paymentIntent = await stripe.paymentIntents.create(paymentIntentData);

    return {
      success: true,
      client_secret: paymentIntent.client_secret,
      payment_intent_id: paymentIntent.id
    };
  } catch (error) {
    console.error('Stripe payment intent error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Confirm payment intent with payment method
 */
async function confirmPaymentIntent(paymentIntentId, paymentMethodId) {
  try {
    const confirmData = {
      payment_method: paymentMethodId
    };

    // Add return_url for safety, even though we've disabled redirects
    // This ensures compatibility if payment method types change
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    confirmData.return_url = `${baseUrl}/payment/success`;

    const paymentIntent = await stripe.paymentIntents.confirm(paymentIntentId, confirmData);
    
    return {
      success: paymentIntent.status === 'succeeded',
      status: paymentIntent.status,
      amount: paymentIntent.amount / 100,
      payment_intent: paymentIntent
    };
  } catch (error) {
    console.error('Payment confirmation error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Verify payment completion
 */
async function verifyPayment(paymentIntentId) {
  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    return {
      success: paymentIntent.status === 'succeeded',
      status: paymentIntent.status,
      amount: paymentIntent.amount / 100
    };
  } catch (error) {
    console.error('Payment verification error:', error);
    
    // Check if it's an API key error and return special error code
    if (error.message && error.message.toLowerCase().includes('invalid api key')) {
      return {
        success: false,
        error: 'STRIPE_API_KEY_ERROR',
        original_error: error.message
      };
    }
    
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Process mock payment for testing
 */
function processMockPayment(testCardNumber, amount) {
  const testCards = {
    '4242424242424242': { success: true, message: 'Payment succeeded' },
    '4000000000000002': { success: false, message: 'Card declined' },
    '4000000000009995': { success: false, message: 'Insufficient funds' }
  };
  
  const result = testCards[testCardNumber] || testCards['4242424242424242'];
  
  return {
    success: result.success,
    message: result.message,
    payment_reference: result.success ? `MOCK_${Date.now()}` : null,
    amount: result.success ? amount : 0
  };
}

module.exports = {
  createPaymentIntent,
  confirmPaymentIntent,
  verifyPayment,
  processMockPayment
};