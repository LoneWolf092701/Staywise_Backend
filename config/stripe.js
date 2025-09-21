const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const createPaymentIntent = async (amount, currency = 'lkr', metadata = {}) => {
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: currency,
      metadata: metadata,
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: 'never'
      },
    });

    return paymentIntent;
  } catch (error) {
    console.error('Error creating payment intent:', error);
    throw error;
  }
};

const confirmPaymentIntent = async (paymentIntentId, paymentMethodId) => {
  try {
    const confirmData = {
      payment_method: paymentMethodId,
    };

    // Add return_url for safety
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    confirmData.return_url = `${baseUrl}/payment/success`;

    const paymentIntent = await stripe.paymentIntents.confirm(paymentIntentId, confirmData);


    return paymentIntent;
  } catch (error) {
    console.error('Error confirming payment intent:', error);
    throw error;
  }
};

const retrievePaymentIntent = async (paymentIntentId) => {
  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    return paymentIntent;
  } catch (error) {
    console.error('Error retrieving payment intent:', error);
    throw error;
  }
};

module.exports = {
  stripe,
  createPaymentIntent,
  confirmPaymentIntent,
  retrievePaymentIntent
};