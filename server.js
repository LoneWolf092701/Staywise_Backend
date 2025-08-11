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

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use((req, res, next) => {
  req.requestId = Math.random().toString(36).substring(2);
  req.timestamp = new Date().toISOString();
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api/properties', propertyRoutes);
app.use('/api/user-interactions', userInteractionRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/upload', uploadRoutes);

app.get('/health', async (req, res) => {
  try {
    const dbStatus = await healthCheck();
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: dbStatus,
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
      },
      environment: process.env.NODE_ENV || 'development'
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/docs', (req, res) => {
  res.json({
    title: 'StayWise API Documentation',
    version: '1.0.0',
    description: 'Property rental management system API',
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
      console.log(`   Upload routes: http://localhost:${PORT}/api/upload`);
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