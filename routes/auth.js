const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query, getConnection } = require('../config/db');
const { auth, requireAdmin } = require('../middleware/auth');

const generateToken = (user) => {
  return jwt.sign(
    { 
      user: { 
        id: user.id, 
        username: user.username, 
        email: user.email, 
        role: user.role 
      } 
    },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );
};

router.post('/register', async (req, res) => {
  const { username, email, password, role = 'user' } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({
      error: 'Missing required fields',
      message: 'Username, email, and password are required'
    });
  }

  if (username.length < 3) {
    return res.status(400).json({
      error: 'Invalid username',
      message: 'Username must be at least 3 characters long'
    });
  }

  if (password.length < 6) {
    return res.status(400).json({
      error: 'Invalid password',
      message: 'Password must be at least 6 characters long'
    });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({
      error: 'Invalid email',
      message: 'Please provide a valid email address'
    });
  }

  const allowedRoles = ['user', 'propertyowner', 'admin'];
  if (!allowedRoles.includes(role)) {
    return res.status(400).json({
      error: 'Invalid role',
      message: 'Role must be user, propertyowner, or admin'
    });
  }

  try {
    const existingUsers = await query(
      'SELECT id, username, email FROM users WHERE username = ? OR email = ?',
      [username, email]
    );

    if (existingUsers.length > 0) {
      const existingUser = existingUsers[0];
      const conflictField = existingUser.username === username ? 'username' : 'email';
      return res.status(409).json({
        error: 'User already exists',
        message: `A user with this ${conflictField} already exists`,
        field: conflictField
      });
    }

    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const result = await query(
      'INSERT INTO users (username, email, password, role, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, 0, NOW(), NOW())',
      [username, email, hashedPassword, role]
    );

    const newUser = {
      id: result.insertId,
      username,
      email,
      role
    };

    const token = generateToken(newUser);

    res.status(201).json({
      message: 'User registered successfully',
      token,
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        role: newUser.role
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      error: 'Registration failed',
      message: 'An error occurred during registration. Please try again.'
    });
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      error: 'Missing credentials',
      message: 'Username and password are required'
    });
  }

  try {
    const users = await query(
      'SELECT id, username, email, password, role, email_verified FROM users WHERE username = ? OR email = ?',
      [username, username]
    );

    if (users.length === 0) {
      return res.status(401).json({
        error: 'Invalid credentials',
        message: 'Username or password is incorrect'
      });
    }

    const user = users[0];

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({
        error: 'Invalid credentials',
        message: 'Username or password is incorrect'
      });
    }

    const token = generateToken(user);

    await query(
      'UPDATE users SET updated_at = NOW() WHERE id = ?',
      [user.id]
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        email_verified: user.email_verified
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      error: 'Login failed',
      message: 'An error occurred during login. Please try again.'
    });
  }
});

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({
      error: 'Missing email',
      message: 'Email address is required'
    });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({
      error: 'Invalid email',
      message: 'Please provide a valid email address'
    });
  }

  try {
    const users = await query(
      'SELECT id, username, email FROM users WHERE email = ?',
      [email]
    );

    if (users.length === 0) {
      return res.json({
        message: 'If an account with that email exists, we have sent a password reset link.',
        info: 'For security reasons, we always show this message'
      });
    }

    const user = users[0];
    const resetToken = jwt.sign(
      { userId: user.id, email: user.email, purpose: 'password-reset' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    console.log(`Password reset requested for user ${user.username} (${user.email})`);
    console.log(`Reset token: ${resetToken}`);
    console.log('In production, this token would be sent via email');

    res.json({
      message: 'If an account with that email exists, we have sent a password reset link.',
      resetToken: resetToken
    });

  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({
      error: 'Request failed',
      message: 'Unable to process password reset request. Please try again.'
    });
  }
});

router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({
      error: 'Missing required fields',
      message: 'Reset token and new password are required'
    });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({
      error: 'Invalid password',
      message: 'Password must be at least 6 characters long'
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    if (decoded.purpose !== 'password-reset') {
      return res.status(400).json({
        error: 'Invalid token',
        message: 'This token is not valid for password reset'
      });
    }

    const users = await query(
      'SELECT id, username, email FROM users WHERE id = ? AND email = ?',
      [decoded.userId, decoded.email]
    );

    if (users.length === 0) {
      return res.status(400).json({
        error: 'Invalid token',
        message: 'Reset token is invalid or user not found'
      });
    }

    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    await query(
      'UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?',
      [hashedPassword, decoded.userId]
    );

    res.json({
      message: 'Password reset successful',
      info: 'You can now log in with your new password'
    });

  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(400).json({
        error: 'Token expired',
        message: 'Reset token has expired. Please request a new password reset.'
      });
    } else if (error.name === 'JsonWebTokenError') {
      return res.status(400).json({
        error: 'Invalid token',
        message: 'Reset token is invalid'
      });
    }

    console.error('Reset password error:', error);
    res.status(500).json({
      error: 'Reset failed',
      message: 'Unable to reset password. Please try again.'
    });
  }
});

router.post('/change-password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const userId = req.user.id;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      error: 'Missing required fields',
      message: 'Current password and new password are required'
    });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({
      error: 'Invalid password',
      message: 'New password must be at least 6 characters long'
    });
  }

  if (currentPassword === newPassword) {
    return res.status(400).json({
      error: 'Same password',
      message: 'New password must be different from current password'
    });
  }

  try {
    const users = await query(
      'SELECT id, password FROM users WHERE id = ?',
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({
        error: 'User not found',
        message: 'User account not found'
      });
    }

    const user = users[0];
    const isValidPassword = await bcrypt.compare(currentPassword, user.password);

    if (!isValidPassword) {
      return res.status(400).json({
        error: 'Invalid current password',
        message: 'Current password is incorrect'
      });
    }

    const saltRounds = 12;
    const hashedNewPassword = await bcrypt.hash(newPassword, saltRounds);

    await query(
      'UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?',
      [hashedNewPassword, userId]
    );

    res.json({
      message: 'Password changed successfully'
    });

  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      error: 'Change failed',
      message: 'Unable to change password. Please try again.'
    });
  }
});

router.post('/verify-email', async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({
      error: 'Missing token',
      message: 'Verification token is required'
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    if (decoded.purpose !== 'email-verification') {
      return res.status(400).json({
        error: 'Invalid token',
        message: 'This token is not valid for email verification'
      });
    }

    const users = await query(
      'SELECT id, username, email, email_verified FROM users WHERE id = ? AND email = ?',
      [decoded.userId, decoded.email]
    );

    if (users.length === 0) {
      return res.status(400).json({
        error: 'Invalid token',
        message: 'Verification token is invalid or user not found'
      });
    }

    const user = users[0];

    if (user.email_verified) {
      return res.json({
        message: 'Email already verified',
        info: 'Your email address is already verified'
      });
    }

    await query(
      'UPDATE users SET email_verified = 1, updated_at = NOW() WHERE id = ?',
      [decoded.userId]
    );

    res.json({
      message: 'Email verified successfully',
      info: 'Your email address has been verified'
    });

  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(400).json({
        error: 'Token expired',
        message: 'Verification token has expired. Please request a new verification email.'
      });
    } else if (error.name === 'JsonWebTokenError') {
      return res.status(400).json({
        error: 'Invalid token',
        message: 'Verification token is invalid'
      });
    }

    console.error('Email verification error:', error);
    res.status(500).json({
      error: 'Verification failed',
      message: 'Unable to verify email. Please try again.'
    });
  }
});

router.post('/resend-verification', auth, async (req, res) => {
  const userId = req.user.id;

  try {
    const users = await query(
      'SELECT id, username, email, email_verified FROM users WHERE id = ?',
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({
        error: 'User not found',
        message: 'User account not found'
      });
    }

    const user = users[0];

    if (user.email_verified) {
      return res.json({
        message: 'Email already verified',
        info: 'Your email address is already verified'
      });
    }

    const verificationToken = jwt.sign(
      { userId: user.id, email: user.email, purpose: 'email-verification' },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    console.log(`Email verification requested for user ${user.username} (${user.email})`);
    console.log(`Verification token: ${verificationToken}`);
    console.log('In production, this token would be sent via email');

    res.json({
      message: 'Verification email sent',
      info: 'A new verification email has been sent to your email address',
      verificationToken: verificationToken
    });

  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({
      error: 'Request failed',
      message: 'Unable to send verification email. Please try again.'
    });
  }
});

router.get('/me', auth, async (req, res) => {
  try {
    const users = await query(
      'SELECT id, username, email, role, email_verified, created_at FROM users WHERE id = ?',
      [req.user.id]
    );

    if (users.length === 0) {
      return res.status(404).json({
        error: 'User not found',
        message: 'User account not found'
      });
    }

    const user = users[0];

    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        email_verified: user.email_verified,
        created_at: user.created_at
      }
    });

  } catch (error) {
    console.error('Get user info error:', error);
    res.status(500).json({
      error: 'Request failed',
      message: 'Unable to retrieve user information'
    });
  }
});

router.get('/users', auth, requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const role = req.query.role || '';

    let whereClause = '';
    let queryParams = [];

    if (search) {
      whereClause += ' WHERE (username LIKE ? OR email LIKE ?)';
      queryParams.push(`%${search}%`, `%${search}%`);
    }

    if (role) {
      whereClause += search ? ' AND role = ?' : ' WHERE role = ?';
      queryParams.push(role);
    }

    const countQuery = `SELECT COUNT(*) as total FROM users${whereClause}`;
    const countResult = await query(countQuery, queryParams);
    const totalUsers = countResult[0].total;

    const usersQuery = `
      SELECT id, username, email, role, email_verified, created_at, updated_at 
      FROM users${whereClause} 
      ORDER BY created_at DESC 
      LIMIT ? OFFSET ?
    `;
    queryParams.push(limit, offset);

    const users = await query(usersQuery, queryParams);

    res.json({
      users: users,
      pagination: {
        page: page,
        limit: limit,
        total: totalUsers,
        totalPages: Math.ceil(totalUsers / limit),
        hasNext: page < Math.ceil(totalUsers / limit),
        hasPrevious: page > 1
      }
    });

  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({
      error: 'Request failed',
      message: 'Unable to retrieve users list'
    });
  }
});

module.exports = router;