const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const rateLimit = require('express-rate-limit');

// Load environment variables first
dotenv.config();

// Import database connection
const db = require('./config/db');

// Import all route modules
const authRoutes = require('./routes/auth');
const propertyRoutes = require('./routes/properties');
const userInteractionsRouter = require('./routes/userInteractions');
const adminRoutes = require('./routes/admin'); 
const profileRoutes = require('./routes/profile');
const bookingRoutes = require('./routes/bookings');

const app = express();

// Trust proxy for accurate IP addresses (essential for rate limiting and logging)
app.set('trust proxy', 1);

// Rate limiting middleware - prevents abuse and DOS attacks
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests',
    message: 'Please try again later',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting to all requests
app.use(limiter);

// CORS configuration with security considerations
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or Postman)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      process.env.CLIENT_URL || 'http://localhost:3000',
      'http://localhost:3000',
      'http://localhost:3001' // For development testing
    ];
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-csrf-token'],
  exposedHeaders: ['x-csrf-token']
}));

// Body parsing with size limits and security
app.use(express.json({ 
  limit: '10mb',
  // Add JSON parsing error handler
  verify: (req, res, buf) => {
    try {
      JSON.parse(buf);
    } catch (e) {
      res.status(400).json({
        error: 'Invalid JSON',
        message: 'Request body contains malformed JSON'
      });
      throw new Error('Invalid JSON');
    }
  }
}));

app.use(express.urlencoded({ 
  extended: true, 
  limit: '10mb' 
}));

// Request ID middleware for better error tracking
app.use((req, res, next) => {
  req.id = Date.now().toString(36) + Math.random().toString(36).substr(2);
  next();
});

// Request logging middleware with security headers
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  const userAgent = req.get('User-Agent') || 'Unknown';
  
  console.log(`[${timestamp}] ${req.method} ${req.path} - IP: ${req.ip} - ID: ${req.id} - Agent: ${userAgent}`);
  
  // Add security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  next();
});

// Health check endpoint with detailed status information
app.get('/health', (req, res) => {
  // Test database connection
  db.query('SELECT 1', (err) => {
    const healthStatus = {
      status: err ? 'ERROR' : 'OK',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
      version: process.env.npm_package_version || '1.0.0',
      database: err ? 'disconnected' : 'connected'
    };

    if (err) {
      console.error('Health check database error:', err);
      return res.status(503).json(healthStatus);
    }

    res.status(200).json(healthStatus);
  });
});

// API information endpoint with comprehensive documentation
app.get('/api', (req, res) => {
  res.json({
    message: 'StayWise Property Rental API',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    endpoints: {
      auth: '/api/auth',
      properties: '/api/properties',
      userInteractions: '/api/user-interactions',
      admin: '/api/admin',
      profile: '/api/profile',
      bookings: '/api/bookings'
    },
    documentation: '/api/docs',
    health: '/health'
  });
});

// API documentation endpoint
app.get('/api/docs', (req, res) => {
  res.json({
    title: 'StayWise API Documentation',
    version: '1.0.0',
    description: 'REST API for StayWise Property Rental Platform',
    baseURL: `${req.protocol}://${req.get('host')}/api`,
    authentication: 'Bearer Token (JWT)',
    rateLimit: '100 requests per 15 minutes per IP',
    endpoints: {
      // Authentication endpoints
      'POST /auth/register': {
        description: 'Register new user',
        authentication: false,
        body: ['username', 'email', 'password', 'role?']
      },
      'POST /auth/login': {
        description: 'User login',
        authentication: false,
        body: ['username', 'password']
      },
      'POST /auth/forgot-password': {
        description: 'Initiate password reset',
        authentication: false,
        body: ['email']
      },
      'POST /auth/reset-password': {
        description: 'Reset password with token',
        authentication: false,
        body: ['token', 'newPassword', 'confirmPassword']
      },
      'GET /auth/verify-token': {
        description: 'Verify JWT token',
        authentication: true
      },
      
      // Property endpoints
      'GET /properties/public': {
        description: 'Get all public properties',
        authentication: false
      },
      'GET /properties/public/:id': {
        description: 'Get specific public property',
        authentication: false
      },
      'POST /properties/details': {
        description: 'Add property details',
        authentication: true,
        role: 'propertyowner'
      },
      'GET /properties/details': {
        description: 'Get user properties',
        authentication: true,
        role: 'propertyowner'
      },
      'PUT /properties/details/:id': {
        description: 'Update property',
        authentication: true,
        role: 'propertyowner'
      },
      
      // User interaction endpoints
      'POST /user-interactions/favourite': {
        description: 'Set/update favourite status',
        authentication: true
      },
      'GET /user-interactions/favourites': {
        description: 'Get user favourites',
        authentication: true
      },
      
      // Booking endpoints
      'POST /bookings/request': {
        description: 'Submit booking request',
        authentication: true,
        role: 'user'
      },
      'GET /bookings/user': {
        description: 'Get user bookings',
        authentication: true,
        role: 'user'
      },
      'GET /bookings/owner': {
        description: 'Get property owner bookings',
        authentication: true,
        role: 'propertyowner'
      },
      
      // Profile endpoints
      'GET /profile': {
        description: 'Get user profile',
        authentication: true
      },
      'PUT /profile': {
        description: 'Update user profile',
        authentication: true
      },
      'PUT /profile/password': {
        description: 'Change password',
        authentication: true
      },
      
      // Admin endpoints
      'GET /admin/pending-properties': {
        description: 'Get pending properties',
        authentication: true,
        role: 'admin'
      },
      'POST /admin/approve-property/:id': {
        description: 'Approve property',
        authentication: true,
        role: 'admin'
      }
    }
  });
});

// Route mounting - order is critical for proper request handling
app.use('/api/auth', authRoutes);
app.use('/api/properties', propertyRoutes); 
app.use('/api/user-interactions', userInteractionsRouter);
app.use('/api/admin', adminRoutes); 
app.use('/api/profile', profileRoutes);
app.use('/api/bookings', bookingRoutes);

// Static file serving for production deployment
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'build')));
  
  // Catch-all handler for client-side routing
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'build', 'index.html'));
  });
}

// Comprehensive error handling middleware with consistent response format
app.use((err, req, res, next) => {
  console.error(`❌ Error [${req.id}]:`, {
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    url: req.url,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  
  // Handle specific error types with appropriate responses
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ 
      error: 'Invalid JSON',
      message: 'Request body contains malformed JSON',
      requestId: req.id
    });
  }
  
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ 
      error: 'Payload too large',
      message: 'Request body exceeds maximum allowed size',
      requestId: req.id
    });
  }

  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({
      error: 'CORS policy violation',
      message: 'Origin not allowed by CORS policy',
      requestId: req.id
    });
  }

  // Default error response with consistent format
  res.status(err.status || 500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' 
      ? err.message 
      : 'An unexpected error occurred. Please try again later.',
    requestId: req.id,
    timestamp: new Date().toISOString()
  });
});

// 404 handler for unmatched routes with helpful information
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Route not found',
    message: `Route ${req.method} ${req.originalUrl} not found`,
    requestId: req.id,
    availableRoutes: [
      '/api/auth',
      '/api/properties', 
      '/api/user-interactions',
      '/api/admin',
      '/api/profile',
      '/api/bookings',
      '/health',
      '/api',
      '/api/docs'
    ],
    suggestion: 'Check the API documentation at /api/docs for available endpoints'
  });
});

// Server startup with comprehensive configuration display
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || 'localhost';

const server = app.listen(PORT, HOST, () => {
  console.log('\n🚀 ===== StayWise API Server Started =====');
  console.log(`📡 Server running on: http://${HOST}:${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📊 Database: ${process.env.DB_NAME || 'staywise_db'}`);
  console.log(`🔒 Rate limit: 100 requests per 15 minutes per IP`);
  console.log('\n📋 Available API Endpoints:');
  console.log(`   🔐 Auth routes: http://${HOST}:${PORT}/api/auth`);
  console.log(`   🏠 Property routes: http://${HOST}:${PORT}/api/properties`);
  console.log(`   👤 User interactions: http://${HOST}:${PORT}/api/user-interactions`);
  console.log(`   📊 Admin routes: http://${HOST}:${PORT}/api/admin`);
  console.log(`   👨‍💼 Profile routes: http://${HOST}:${PORT}/api/profile`);
  console.log(`   📅 Booking routes: http://${HOST}:${PORT}/api/bookings`);
  console.log(`   💚 Health check: http://${HOST}:${PORT}/health`);
  console.log(`   📚 API docs: http://${HOST}:${PORT}/api/docs`);
  console.log('\n✅ Server ready to accept connections!');
});

// Graceful shutdown handling with cleanup
process.on('SIGTERM', () => {
  console.log('\n🛑 SIGTERM received. Starting graceful shutdown...');
  server.close(() => {
    console.log('✅ HTTP server closed');
    // Close database connections
    db.end(() => {
      console.log('✅ Database connections closed');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  console.log('\n🛑 SIGINT received. Starting graceful shutdown...');
  server.close(() => {
    console.log('✅ HTTP server closed');
    // Close database connections
    db.end(() => {
      console.log('✅ Database connections closed');
      process.exit(0);
    });
  });
});

// Error handling for uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', {
    message: err.message,
    stack: err.stack,
    timestamp: new Date().toISOString()
  });
  
  // Attempt graceful shutdown
  server.close(() => {
    process.exit(1);
  });
  
  // Force exit after 10 seconds if graceful shutdown fails
  setTimeout(() => {
    console.error('❌ Forced exit due to uncaught exception');
    process.exit(1);
  }, 10000);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', {
    reason: reason,
    promise: promise,
    timestamp: new Date().toISOString()
  });
  
  // Don't exit the process for unhandled rejections in production
  if (process.env.NODE_ENV === 'development') {
    process.exit(1);
  }
});

module.exports = app;