const jwt = require('jsonwebtoken');

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

const validateUserExists = (req, res, next) => {
  if (!req.user || !req.user.id) {
    return res.status(401).json({ 
      error: 'Invalid user data',
      message: 'Please log in again',
      redirectTo: '/login'
    });
  }
  
  const db = require('../config/db');
  
  db.query(
    'SELECT id, username, email, role FROM users WHERE id = ?',
    [req.user.id],
    (err, results) => {
      if (err) {
        console.error('Error validating user:', err);
        return res.status(500).json({ 
          error: 'Database error',
          message: 'Unable to validate user'
        });
      }
      
      if (results.length === 0) {
        return res.status(401).json({ 
          error: 'User not found',
          message: 'Your account may have been deleted. Please contact support.',
          redirectTo: '/login'
        });
      }
      
      const dbUser = results[0];
      if (dbUser.role !== req.user.role) {
        return res.status(401).json({ 
          error: 'Role mismatch',
          message: 'Your account permissions have changed. Please log in again.',
          redirectTo: '/login'
        });
      }
      
      req.user.username = dbUser.username;
      req.user.email = dbUser.email;
      
      next();
    }
  );
};

const rateLimitByUser = (maxRequests = 100, windowMs = 15 * 60 * 1000) => {
  const requests = new Map();
  
  return (req, res, next) => {
    if (!req.user || !req.user.id) {
      return next();
    }
    
    const userId = req.user.id;
    const now = Date.now();
    const userRequests = requests.get(userId) || [];
    
    const validRequests = userRequests.filter(timestamp => 
      now - timestamp < windowMs
    );
    
    if (validRequests.length >= maxRequests) {
      return res.status(429).json({
        error: 'Too many requests',
        message: 'You have exceeded the request limit. Please try again later.',
        retryAfter: Math.ceil(windowMs / 1000)
      });
    }
    
    validRequests.push(now);
    requests.set(userId, validRequests);
    
    next();
  };
};

const auditLog = (action) => {
  return (req, res, next) => {
    const originalSend = res.send;
    
    res.send = function(data) {
      if (req.user) {
        console.log(`[AUDIT] User ${req.user.id} (${req.user.role}) performed ${action} at ${new Date().toISOString()}`);
        console.log(`[AUDIT] Request: ${req.method} ${req.originalUrl}`);
        console.log(`[AUDIT] Response Status: ${res.statusCode}`);
      }
      
      originalSend.call(this, data);
    };
    
    next();
  };
};

module.exports = auth;
module.exports.requireRole = requireRole;
module.exports.requireAdmin = requireAdmin;
module.exports.requirePropertyOwner = requirePropertyOwner;
module.exports.requireUser = requireUser;
module.exports.optionalAuth = optionalAuth;
module.exports.checkTokenExpiry = checkTokenExpiry;
module.exports.validateUserExists = validateUserExists;
module.exports.rateLimitByUser = rateLimitByUser;
module.exports.auditLog = auditLog;