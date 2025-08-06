const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const morgan = require('morgan');
require('dotenv').config();

const { initializeDatabase, gracefulShutdown, healthCheck } = require('./config/db');

const authRoutes = require('./routes/auth');
const propertyRoutes = require('./routes/properties');
const userInteractionRoutes = require('./routes/userInteractions');
const adminRoutes = require('./routes/admin');
const profileRoutes = require('./routes/profile');
const bookingRoutes = require('./routes/bookings');

const app = express();

app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['X-Token-Warning']
}));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false
}));

app.use(compression());

app.use(morgan('combined', {
  stream: {
    write: (message) => {
      console.log(`[${new Date().toISOString()}] ${message.trim()}`);
    }
  }
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    error: 'Too many requests',
    message: 'Too many requests from this IP, please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.log(`Rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      error: 'Too many requests',
      message: 'Too many requests from this IP, please try again later.',
      retryAfter: '15 minutes'
    });
  }
});

app.use(limiter);

app.use(express.json({ 
  limit: '10mb',
  strict: true
}));
app.use(express.urlencoded({ 
  extended: true, 
  limit: '10mb' 
}));

app.use((req, res, next) => {
  const requestId = Math.random().toString(36).substring(2, 15);
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  next();
});

app.use((req, res, next) => {
  const userAgent = req.get('User-Agent') || 'Unknown';
  const ip = req.ip || req.connection.remoteAddress || 'Unknown';
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} - IP: ${ip} - ID: ${req.requestId} - Agent: ${userAgent}`);
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api/properties', propertyRoutes);
app.use('/api/user-interactions', userInteractionRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/bookings', bookingRoutes);

app.get('/health', async (req, res) => {
  try {
    const dbHealth = await healthCheck();
    const serverHealth = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      environment: process.env.NODE_ENV || 'development'
    };

    res.json({
      server: serverHealth,
      database: dbHealth,
      overall: dbHealth.status === 'healthy' ? 'healthy' : 'degraded'
    });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({
      server: {
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString()
      },
      database: {
        status: 'unknown'
      },
      overall: 'unhealthy'
    });
  }
});

app.get('/api/docs', (req, res) => {
  res.json({
    title: 'StayWise API Documentation',
    version: '1.0.0',
    description: 'REST API for StayWise property management platform',
    endpoints: {
      authentication: {
        'POST /api/auth/register': 'Register a new user',
        'POST /api/auth/login': 'Login user',
        'POST /api/auth/forgot-password': 'Request password reset',
        'POST /api/auth/reset-password': 'Reset password with token',
        'POST /api/auth/change-password': 'Change password (authenticated)',
        'POST /api/auth/verify-email': 'Verify email address',
        'POST /api/auth/resend-verification': 'Resend verification email'
      },
      properties: {
        'GET /api/properties': 'Get all approved properties',
        'GET /api/properties/search': 'Search properties with filters',
        'GET /api/properties/:id': 'Get property by ID',
        'POST /api/properties': 'Create new property (property owner)',
        'PUT /api/properties/:id': 'Update property (owner/admin)',
        'DELETE /api/properties/:id': 'Delete property (owner/admin)',
        'GET /api/properties/owner/mine': 'Get properties owned by current user'
      },
      userInteractions: {
        'POST /api/user-interactions/favorite': 'Add/remove property favorite',
        'POST /api/user-interactions/rating': 'Rate a property',
        'POST /api/user-interactions/complaint': 'Submit property complaint',
        'POST /api/user-interactions/view': 'Track property view',
        'GET /api/user-interactions/favorites': 'Get user favorites',
        'GET /api/user-interactions/ratings': 'Get user ratings'
      },
      admin: {
        'GET /api/admin/users': 'Get all users (admin)',
        'GET /api/admin/properties/pending': 'Get pending properties',
        'PUT /api/admin/properties/:id/approve': 'Approve property',
        'PUT /api/admin/properties/:id/reject': 'Reject property',
        'GET /api/admin/complaints': 'Get all complaints',
        'PUT /api/admin/complaints/:id': 'Update complaint status'
      },
      profile: {
        'GET /api/profile': 'Get user profile',
        'PUT /api/profile': 'Update user profile',
        'POST /api/profile/avatar': 'Upload profile avatar'
      },
      bookings: {
        'POST /api/bookings': 'Create booking request',
        'GET /api/bookings': 'Get user bookings',
        'GET /api/bookings/owner': 'Get bookings for property owner',
        'PUT /api/bookings/:id/status': 'Update booking status'
      }
    },
    authentication: 'Bearer token required for protected endpoints',
    rateLimit: '100 requests per 15 minutes per IP'
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'StayWise API Server',
    version: '1.0.0',
    status: 'active',
    documentation: '/api/docs',
    health: '/health'
  });
});

app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.originalUrl} not found`,
    timestamp: new Date().toISOString()
  });
});

app.use((error, req, res, next) => {
  console.error('Uncaught Exception:', {
    message: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString()
  });

  if (res.headersSent) {
    return next(error);
  }

  const statusCode = error.statusCode || error.status || 500;
  const message = error.message || 'Internal Server Error';

  res.status(statusCode).json({
    error: 'Server Error',
    message: message,
    requestId: req.requestId,
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 5000;
let server;

const startServer = async () => {
  try {
    const dbInitialized = await initializeDatabase();
    if (!dbInitialized) {
      console.error('Failed to initialize database. Exiting...');
      process.exit(1);
    }

    server = app.listen(PORT, () => {
      console.log('\n===== StayWise API Server Started =====');
      console.log(`Server running on: http://localhost:${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`Database: ${process.env.DB_NAME || 'staywise_db'}`);
      console.log(`Rate limit: 100 requests per 15 minutes per IP`);
      console.log('\nAvailable API Endpoints:');
      console.log(`   Auth routes: http://localhost:${PORT}/api/auth`);
      console.log(`   Property routes: http://localhost:${PORT}/api/properties`);
      console.log(`   User interactions: http://localhost:${PORT}/api/user-interactions`);
      console.log(`   Admin routes: http://localhost:${PORT}/api/admin`);
      console.log(`   Profile routes: http://localhost:${PORT}/api/profile`);
      console.log(`   Booking routes: http://localhost:${PORT}/api/bookings`);
      console.log(`   Health check: http://localhost:${PORT}/health`);
      console.log(`   API docs: http://localhost:${PORT}/api/docs`);
      console.log('\nServer ready to accept connections!');
    });

    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Please use a different port.`);
      } else {
        console.error('Server error:', error);
      }
      process.exit(1);
    });

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

const handleShutdown = async (signal) => {
  console.log(`\nReceived ${signal}. Starting graceful shutdown...`);
  
  if (server) {
    server.close(async (err) => {
      if (err) {
        console.error('Error closing HTTP server:', err);
      } else {
        console.log('HTTP server closed');
      }

      try {
        await gracefulShutdown();
        console.log('Graceful shutdown completed');
        process.exit(0);
      } catch (error) {
        console.error('Error during graceful shutdown:', error);
        process.exit(1);
      }
    });

    setTimeout(() => {
      console.error('Forced shutdown due to timeout');
      process.exit(1);
    }, 10000);
  } else {
    process.exit(0);
  }
};

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', {
    message: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString()
  });
  
  handleShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  handleShutdown('unhandledRejection');
});

startServer();