const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files from uploads directory
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Import route files
const authRoutes = require('./routes/auth');
const propertiesRoutes = require('./routes/properties');
const profileRoutes = require('./routes/profile');
const adminRoutes = require('./routes/admin');
const bookingsRoutes = require('./routes/bookings');
const userInteractionsRoutes = require('./routes/userInteractions');

// Register API routes
app.use('/api/auth', authRoutes);
app.use('/api/properties', propertiesRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/bookings', bookingsRoutes);
app.use('/api/user-interactions', userInteractionsRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Catch-all route for undefined API endpoints
app.use('/api/*', (req, res) => {
  res.status(404).json({ 
    error: 'Route not found',
    message: `Route ${req.method} ${req.originalUrl} not found`,
    availableRoutes: ['/api/auth', '/api/properties', '/api/user-interactions', '/api/admin', '/api/profile'],
    suggestion: 'Check the API documentation at /api/docs for available endpoints'
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🌐 CORS enabled for: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`);
  console.log(`📋 Available routes:`);
  console.log(`   - /api/auth (Authentication)`);
  console.log(`   - /api/properties (Property management)`);
  console.log(`   - /api/user-interactions (Ratings, Favorites, Complaints)`);
  console.log(`   - /api/admin (Admin functions)`);
  console.log(`   - /api/profile (User profiles)`);
  console.log(`   - /api/bookings (Booking requests)`);
});

module.exports = app;