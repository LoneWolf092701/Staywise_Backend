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
const uploadRoutes = require('./routes/upload');
const { router: notificationRoutes } = require('./routes/notifications');
const settingsRoutes = require('./routes/settings');
const paymentRoutes = require('./routes/payments');

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

// Different rate limits for different environments
const isDevelopment = process.env.NODE_ENV === 'development';

// General rate limiter - more lenient for development
const limiter = rateLimit({
  windowMs: 15 * 60 * 10000, // 15 minutes
  max: isDevelopment ? 100000 : 10000, // 1000 requests for dev, 100 for production
  message: {
    error: 'Too many requests',
    message: 'Too many requests from this IP, please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for health checks and static assets
    return req.path === '/health' || 
           req.path.startsWith('/static/') || 
           req.path.startsWith('/assets/');
  },
  handler: (req, res) => {
    console.log(`Rate limit exceeded for IP: ${req.ip} - Path: ${req.path}`);
    res.status(429).json({
      error: 'Too many requests',
      message: 'Too many requests from this IP, please try again later.',
      retryAfter: '15 minutes',
      path: req.path
    });
  }
});

// Strict rate limiter for sensitive operations
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isDevelopment ? 50 : 10, // 50 requests for dev, 10 for production
  message: {
    error: 'Too many requests',
    message: 'Too many sensitive operation requests. Please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.log(`Strict rate limit exceeded for IP: ${req.ip} - Path: ${req.path}`);
    res.status(429).json({
      error: 'Too many requests',
      message: 'Too many sensitive operation requests. Please try again later.',
      retryAfter: '15 minutes'
    });
  }
});

app.use(limiter);

// Apply strict rate limiting to sensitive endpoints
app.use('/api/auth/login', strictLimiter);
app.use('/api/auth/register', strictLimiter);
app.use('/api/auth/forgot-password', strictLimiter);
app.use('/api/auth/reset-password', strictLimiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
  req.requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api/properties', propertyRoutes);
app.use('/api/user-interactions', userInteractionRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/payments', paymentRoutes);

app.get('/health', async (req, res) => {
  try {
    const dbHealth = await healthCheck();
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      database: dbHealth.status === 'connected' ? 'healthy' : 'unhealthy',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      version: '1.0.0',
      rateLimit: {
        general: isDevelopment ? '1000 requests per 15 minutes' : '100 requests per 15 minutes',
        auth: isDevelopment ? '50 requests per 15 minutes' : '10 requests per 15 minutes'
      }
    });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Health check failed'
    });
  }
});

app.get('/api/docs', (req, res) => {
  res.json({
    title: 'StayWise API Documentation',
    version: '1.0.0',
    description: 'Comprehensive property rental management system API',
    endpoints: {
      authentication: {
        'POST /api/auth/login': 'User login',
        'POST /api/auth/register': 'User registration',
        'POST /api/auth/logout': 'User logout',
        'POST /api/auth/refresh-token': 'Refresh JWT token',
        'POST /api/auth/forgot-password': 'Request password reset',
        'POST /api/auth/reset-password': 'Reset password with token'
      },
      properties: {
        'GET /api/properties/public': 'Get all public properties',
        'GET /api/properties/public/:id': 'Get public property details',
        'POST /api/properties': 'Create new property (property owners)',
        'PUT /api/properties/:id': 'Update property',
        'DELETE /api/properties/:id': 'Delete property',
        'GET /api/properties/owner/mine': 'Get properties owned by current user'
      },
      upload: {
        'POST /api/upload/single': 'Upload single file',
        'POST /api/upload/multiple': 'Upload multiple files',
        'DELETE /api/upload/file': 'Delete uploaded file'
      },
      profile: {
        'GET /api/profile': 'Get user profile',
        'PUT /api/profile': 'Update user profile',
        'POST /api/profile/avatar': 'Upload profile image'
      },
      bookings: {
        'POST /api/bookings': 'Create booking request',
        'GET /api/bookings/user': 'Get user bookings',
        'GET /api/bookings/owner': 'Get bookings for property owner',
        'PUT /api/bookings/:id/status': 'Update booking status'
      },
      notifications: {
        'GET /api/notifications': 'Get user notifications',
        'PUT /api/notifications/:id/read': 'Mark notification as read',
        'PUT /api/notifications/mark-all-read': 'Mark all notifications as read',
        'PUT /api/notifications/:id/action': 'Take action on notification (accept/reject)',
        'GET /api/notifications/unread-count': 'Get unread notification count',
        'DELETE /api/notifications/:id': 'Delete notification'
      }
    },
    authentication: 'Bearer token required for protected endpoints',
    rateLimit: isDevelopment 
      ? 'Development: 1000 requests per 15 minutes per IP (Auth: 50 requests per 15 minutes)'
      : 'Production: 100 requests per 15 minutes per IP (Auth: 10 requests per 15 minutes)'
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'StayWise API Server',
    version: '1.0.0',
    status: 'active',
    environment: process.env.NODE_ENV || 'development',
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
      
      if (isDevelopment) {
        console.log(`Rate limit: 1000 requests per 15 minutes per IP (Development Mode)`);
        console.log(`Auth rate limit: 50 requests per 15 minutes per IP (Development Mode)`);
      } else {
        console.log(`Rate limit: 100 requests per 15 minutes per IP (Production Mode)`);
        console.log(`Auth rate limit: 10 requests per 15 minutes per IP (Production Mode)`);
      }
      
      console.log('\nAvailable API Endpoints:');
      console.log(`   Auth routes: http://localhost:${PORT}/api/auth`);
      console.log(`   Property routes: http://localhost:${PORT}/api/properties`);
      console.log(`   Upload routes: http://localhost:${PORT}/api/upload`);
      console.log(`   User interactions: http://localhost:${PORT}/api/user-interactions`);
      console.log(`   Admin routes: http://localhost:${PORT}/api/admin`);
      console.log(`   Profile routes: http://localhost:${PORT}/api/profile`);
      console.log(`   Booking routes: http://localhost:${PORT}/api/bookings`);
      console.log(`   Notification routes: http://localhost:${PORT}/api/notifications`);
      console.log(`   Health check: http://localhost:${PORT}/health`);
      console.log(`   API docs: http://localhost:${PORT}/api/docs`);
      console.log('\nServer ready to accept connections!');
    });

    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Please use a different port.`);
        process.exit(1);
      } else {
        console.error('Server error:', error);
        process.exit(1);
      }
    });

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

const gracefulShutdownHandler = (signal) => {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  
  if (server) {
    server.close(() => {
      console.log('HTTP server closed.');
      gracefulShutdown()
        .then(() => {
          console.log('Database connections closed.');
          process.exit(0);
        })
        .catch((error) => {
          console.error('Error during shutdown:', error);
          process.exit(1);
        });
    });
  } else {
    gracefulShutdown()
      .then(() => {
        console.log('Database connections closed.');
        process.exit(0);
      })
      .catch((error) => {
        console.error('Error during shutdown:', error);
        process.exit(1);
      });
  }
};

process.on('SIGTERM', () => gracefulShutdownHandler('SIGTERM'));
process.on('SIGINT', () => gracefulShutdownHandler('SIGINT'));

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  gracefulShutdownHandler('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdownHandler('unhandledRejection');
});

startServer();