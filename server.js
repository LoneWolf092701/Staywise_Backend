const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const db = require('./config/db');

dotenv.config();

// Import all route modules
const authRoutes = require('./routes/auth');
const propertyRoutes = require('./routes/properties');
const userInteractionsRouter = require('./routes/userInteractions');
const adminRoutes = require('./routes/admin'); 
const profileRoutes = require('./routes/profile');


const app = express();

// Middleware setup
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Route mounting - the order matters for proper request handling
app.use('/api/auth', authRoutes);
app.use('/api/properties', propertyRoutes); 
app.use('/api/user-interactions', userInteractionsRouter);
app.use('/api/admin', adminRoutes); 
app.use('/api/profile', profileRoutes);

// Health check endpoint for monitoring
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 handler for unmatched routes
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Route not found',
    path: req.originalUrl,
    method: req.method
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
  console.log(`📊 Admin routes available at: http://localhost:${PORT}/api/admin`);
  console.log(`🏠 Property routes available at: http://localhost:${PORT}/api/properties`);
  console.log(`🔐 Auth routes available at: http://localhost:${PORT}/api/auth`);
});