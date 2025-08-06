const jwt = require('jsonwebtoken');
const { query } = require('../config/db');

/**
 * Main authentication middleware
 * Verifies JWT token and attaches user data to request
 */
const auth = function (req, res, next) {
  const authHeader = req.header('Authorization');
  
  if (!authHeader) {
    return res.status(401).json({ 
      error: 'No token, authorization denied',
      message: 'Please log in to access this resource',
      redirectTo: '/login'
    });
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ 
      error: 'No token, authorization denied',
      message: 'Invalid authorization format',
      redirectTo: '/login'
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded.user;
    
    if (!req.user || !req.user.id || !req.user.role) {
      return res.status(401).json({ 
        error: 'Invalid token payload',
        message: 'Please log in again',
        redirectTo: '/login'
      });
    }
    
    next(); 
  } catch (err) {
    console.error('JWT verification error:', err.message);
    
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        error: 'Token expired',
        message: 'Your session has expired. Please log in again.',
        redirectTo: '/login'
      });
    } else if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ 
        error: 'Invalid token',
        message: 'Please log in again',
        redirectTo: '/login'
      });
    } else {
      return res.status(401).json({ 
        error: 'Token verification failed',
        message: 'Authentication error. Please log in again.',
        redirectTo: '/login'
      });
    }
  }
};

/**
 * Role-based access control middleware
 * Accepts single role or array of roles
 */
const requireRole = (roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ 
        error: 'Authentication required',
        message: 'Please log in to access this resource',
        redirectTo: '/login'
      });
    }

    const userRole = req.user.role;
    const allowedRoles = Array.isArray(roles) ? roles : [roles];
    
    if (!allowedRoles.includes(userRole)) {
      const roleRedirects = {
        user: '/user-home',
        propertyowner: '/home',
        admin: '/admin/home'
      };
      
      return res.status(403).json({ 
        error: 'Access denied',
        message: `This resource requires ${allowedRoles.join(' or ')} role`,
        userRole: userRole,
        redirectTo: roleRedirects[userRole] || '/login'
      });
    }
    
    next();
  };
};

/**
 * Admin-only access middleware
 */
const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ 
      error: 'Authentication required',
      message: 'Please log in to access this resource',
      redirectTo: '/login'
    });
  }

  if (req.user.role !== 'admin') {
    const roleRedirects = {
      user: '/user-home',
      propertyowner: '/home'
    };
    
    return res.status(403).json({ 
      error: 'Access denied',
      message: 'Admin access required',
      userRole: req.user.role,
      redirectTo: roleRedirects[req.user.role] || '/login'
    });
  }
  
  next();
};

/**
 * Property Owner-only access middleware
 */
const requirePropertyOwner = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ 
      error: 'Authentication required',
      message: 'Please log in to access this resource',
      redirectTo: '/login'
    });
  }

  if (req.user.role !== 'propertyowner') {
    const roleRedirects = {
      user: '/user-home',
      admin: '/admin/home'
    };
    
    return res.status(403).json({ 
      error: 'Access denied',
      message: 'Property owner access required',
      userRole: req.user.role,
      redirectTo: roleRedirects[req.user.role] || '/login'
    });
  }
  
  next();
};

/**
 * User-only access middleware
 */
const requireUser = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ 
      error: 'Authentication required',
      message: 'Please log in to access this resource',
      redirectTo: '/login'
    });
  }

  if (req.user.role !== 'user') {
    const roleRedirects = {
      propertyowner: '/home',
      admin: '/admin/home'
    };
    
    return res.status(403).json({ 
      error: 'Access denied',
      message: 'User access required',
      userRole: req.user.role,
      redirectTo: roleRedirects[req.user.role] || '/login'
    });
  }
  
  next();
};

/**
 * Optional authentication middleware
 * Attaches user if token is present, but doesn't require it
 */
const optionalAuth = (req, res, next) => {
  const authHeader = req.header('Authorization');
  
  if (!authHeader) {
    req.user = null;
    return next();
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    req.user = null;
    return next();
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded.user;
  } catch (err) {
    console.warn('Optional auth failed:', err.message);
    req.user = null;
  }
  
  next();
};

/**
 * Token expiry warning middleware
 * Adds header warning when token is about to expire
 */
const checkTokenExpiry = (req, res, next) => {
  if (!req.user) {
    return next();
  }

  const currentTime = Math.floor(Date.now() / 1000);
  const tokenExp = req.user.exp;
  
  if (tokenExp && currentTime >= tokenExp) {
    return res.status(401).json({ 
      error: 'Token expired',
      message: 'Your session has expired. Please log in again.',
      redirectTo: '/login'
    });
  }
  
  const timeUntilExpiry = tokenExp - currentTime;
  if (timeUntilExpiry < 300) {
    res.setHeader('X-Token-Warning', 'Token expires soon');
  }
  
  next();
};

/**
 * Database user validation middleware
 * Verifies that the user still exists in database and has correct permissions
 */
const validateUserExists = async (req, res, next) => {
  if (!req.user || !req.user.id) {
    return res.status(401).json({ 
      error: 'Invalid user data',
      message: 'Please log in again',
      redirectTo: '/login'
    });
  }
  
  try {
    const users = await query(
      'SELECT id, username, email, role, email_verified FROM users WHERE id = ?',
      [req.user.id]
    );
    
    if (users.length === 0) {
      return res.status(401).json({ 
        error: 'User not found',
        message: 'Your account may have been deleted. Please contact support.',
        redirectTo: '/login'
      });
    }
    
    const dbUser = users[0];
    if (dbUser.role !== req.user.role) {
      return res.status(401).json({ 
        error: 'Role mismatch',
        message: 'Your account permissions have changed. Please log in again.',
        redirectTo: '/login'
      });
    }
    
    req.dbUser = dbUser;
    next();
  } catch (error) {
    console.error('Error validating user:', error);
    return res.status(500).json({ 
      error: 'Database error',
      message: 'Unable to validate user'
    });
  }
};

/**
 * Property ownership verification middleware
 * Verifies that the authenticated user owns the specified property
 */
const requirePropertyOwnership = async (req, res, next) => {
  const propertyId = req.params.id || req.body.property_id;
  const userId = req.user.id;

  if (!propertyId) {
    return res.status(400).json({
      error: 'Missing property ID',
      message: 'Property ID is required'
    });
  }

  try {
    const properties = await query(
      'SELECT id, user_id FROM all_properties WHERE id = ?',
      [propertyId]
    );

    if (properties.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'The specified property does not exist'
      });
    }

    const property = properties[0];
    
    if (property.user_id !== userId && req.user.role !== 'admin') {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You can only access properties you own'
      });
    }

    req.property = property;
    next();
  } catch (error) {
    console.error('Error verifying property ownership:', error);
    return res.status(500).json({
      error: 'Database error',
      message: 'Unable to verify property ownership'
    });
  }
};

/**
 * Rate limiting middleware for sensitive operations
 */
const sensitiveOpRateLimit = (maxAttempts = 5, windowMs = 15 * 60 * 1000) => {
  const attempts = new Map();

  return (req, res, next) => {
    const key = `${req.ip}-${req.user ? req.user.id : 'anonymous'}`;
    const now = Date.now();
    
    if (!attempts.has(key)) {
      attempts.set(key, []);
    }
    
    const userAttempts = attempts.get(key);
    const recentAttempts = userAttempts.filter(time => now - time < windowMs);
    
    if (recentAttempts.length >= maxAttempts) {
      return res.status(429).json({
        error: 'Too many attempts',
        message: `Too many attempts. Please try again later.`,
        retryAfter: Math.ceil(windowMs / 1000 / 60) + ' minutes'
      });
    }
    
    recentAttempts.push(now);
    attempts.set(key, recentAttempts);
    
    next();
  };
};

/**
 * Development-only middleware to log request details
 */
const devLogger = (req, res, next) => {
  if (process.env.NODE_ENV === 'development') {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
    if (req.user) {
      console.log(`  User: ${req.user.username} (${req.user.role})`);
    }
    if (req.body && Object.keys(req.body).length > 0) {
      const sanitizedBody = { ...req.body };
      if (sanitizedBody.password) sanitizedBody.password = '[HIDDEN]';
      if (sanitizedBody.currentPassword) sanitizedBody.currentPassword = '[HIDDEN]';
      if (sanitizedBody.newPassword) sanitizedBody.newPassword = '[HIDDEN]';
      console.log('  Body:', sanitizedBody);
    }
  }
  next();
};

/**
 * Error handler middleware for authentication errors
 */
const authErrorHandler = (error, req, res, next) => {
  if (error.name === 'UnauthorizedError' || error.status === 401) {
    return res.status(401).json({
      error: 'Authentication failed',
      message: 'Invalid or expired token',
      redirectTo: '/login'
    });
  }
  
  if (error.name === 'ForbiddenError' || error.status === 403) {
    return res.status(403).json({
      error: 'Access denied',
      message: 'Insufficient permissions',
      redirectTo: '/unauthorized'
    });
  }
  
  next(error);
};

module.exports = {
  auth,
  requireRole,
  requireAdmin,
  requirePropertyOwner,
  requireUser,
  optionalAuth,
  checkTokenExpiry,
  validateUserExists,
  requirePropertyOwnership,
  sensitiveOpRateLimit,
  devLogger,
  authErrorHandler
};