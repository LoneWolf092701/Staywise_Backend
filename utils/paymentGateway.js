const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

/**
 * Create Stripe payment intent for booking
 */
async function createPaymentIntent(amount, bookingId, userEmail) {
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to cents
      currency: 'usd',
      metadata: {
        booking_id: bookingId.toString(),
        type: 'booking_advance_payment'
      },
      receipt_email: userEmail
    });

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
  verifyPayment,
  processMockPayment
};