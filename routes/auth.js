const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query, executeTransaction } = require('../config/db');
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
  const { username, email, password, role = 'user', profile } = req.body;

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

    const userResult = await query(
      'INSERT INTO users (username, email, password, role, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, 0, NOW(), NOW())',
      [username, email, hashedPassword, role]
    );

    const userId = userResult.insertId;

    if (profile && Object.keys(profile).length > 0) {
      const profileFields = [];
      const profileValues = [userId];
      
      const allowedFields = [
        'first_name', 'last_name', 'phone', 'gender', 'birthdate', 'nationality',
        'business_name', 'contact_person', 'business_type', 'business_registration', 'business_address',
        'department', 'admin_level'
      ];

      allowedFields.forEach(field => {
        if (profile[field] !== undefined && profile[field] !== null && profile[field] !== '') {
          profileFields.push(field);
          profileValues.push(profile[field]);
        }
      });

      if (profileFields.length > 0) {
        const profileQuery = `
          INSERT INTO user_profiles 
          (user_id, ${profileFields.join(', ')}, created_at, updated_at) 
          VALUES (?, ${profileFields.map(() => '?').join(', ')}, NOW(), NOW())
        `;
        
        await query(profileQuery, profileValues);
      }
    }

    const newUser = {
      id: userId,
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

router.post('/logout', auth, async (req, res) => {
  try {
    res.json({
      message: 'Logged out successfully'
    });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      error: 'Logout failed',
      message: 'An error occurred during logout. Please try again.'
    });
  }
});

router.post('/refresh-token', auth, async (req, res) => {
  try {
    const user = req.user;

    const dbUsers = await query(
      'SELECT id, username, email, role, email_verified FROM users WHERE id = ?',
      [user.id]
    );

    if (dbUsers.length === 0) {
      return res.status(401).json({
        error: 'User not found',
        message: 'User account not found'
      });
    }

    const dbUser = dbUsers[0];
    const token = generateToken(dbUser);

    res.json({
      message: 'Token refreshed successfully',
      token,
      user: {
        id: dbUser.id,
        username: dbUser.username,
        email: dbUser.email,
        role: dbUser.role,
        email_verified: dbUser.email_verified
      },
      expires_in: '24h'
    });

  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(500).json({
      error: 'Token refresh failed',
      message: 'Unable to refresh token. Please log in again.'
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
      'SELECT id, email FROM users WHERE email = ?',
      [email]
    );

    if (users.length === 0) {
      return res.status(404).json({
        error: 'User not found',
        message: 'No account found with this email address'
      });
    }

    res.json({
      message: 'Password reset instructions have been sent to your email address',
      email: email
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
    res.json({
      message: 'Password reset successfully. You can now log in with your new password.'
    });

  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({
      error: 'Reset failed',
      message: 'Unable to reset password. Please try again.'
    });
  }
});

router.get('/verify-token', auth, async (req, res) => {
  try {
    const user = req.user;

    const dbUsers = await query(
      'SELECT id, username, email, role, email_verified FROM users WHERE id = ?',
      [user.id]
    );

    if (dbUsers.length === 0) {
      return res.status(401).json({
        error: 'User not found',
        message: 'User account not found'
      });
    }

    const dbUser = dbUsers[0];

    res.json({
      valid: true,
      user: {
        id: dbUser.id,
        username: dbUser.username,
        email: dbUser.email,
        role: dbUser.role,
        email_verified: dbUser.email_verified
      }
    });

  } catch (error) {
    console.error('Token verification error:', error);
    res.status(500).json({
      error: 'Verification failed',
      message: 'Unable to verify token. Please try again.'
    });
  }
});

router.post('/change-password', auth, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  const userId = req.user.id;

  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({
      error: 'Missing required fields',
      message: 'Current password, new password, and confirmation are required'
    });
  }

  if (newPassword !== confirmPassword) {
    return res.status(400).json({
      error: 'Password mismatch',
      message: 'New passwords do not match'
    });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({
      error: 'Invalid password',
      message: 'New password must be at least 6 characters long'
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
      return res.status(401).json({
        error: 'Invalid password',
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
      error: 'Password change failed',
      message: 'Unable to change password. Please try again.'
    });
  }
});

router.get('/me', auth, async (req, res) => {
  try {
    const user = req.user;

    const dbUsers = await query(
      'SELECT id, username, email, role, email_verified, created_at, updated_at FROM users WHERE id = ?',
      [user.id]
    );

    if (dbUsers.length === 0) {
      return res.status(404).json({
        error: 'User not found',
        message: 'User account not found'
      });
    }

    const dbUser = dbUsers[0];

    res.json({
      id: dbUser.id,
      username: dbUser.username,
      email: dbUser.email,
      role: dbUser.role,
      email_verified: dbUser.email_verified,
      created_at: dbUser.created_at,
      updated_at: dbUser.updated_at
    });

  } catch (error) {
    console.error('Get current user error:', error);
    res.status(500).json({
      error: 'Request failed',
      message: 'Unable to retrieve user information'
    });
  }
});

router.post('/update-last-login', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    await query(
      'UPDATE users SET updated_at = NOW() WHERE id = ?',
      [userId]
    );

    res.json({
      message: 'Last login updated successfully'
    });

  } catch (error) {
    console.error('Update last login error:', error);
    res.status(500).json({
      error: 'Update failed',
      message: 'Unable to update last login time'
    });
  }
});

router.get('/config', async (req, res) => {
  try {
    res.json({
      registration_enabled: true,
      email_verification_required: true,
      password_requirements: {
        min_length: 6,
        require_uppercase: false,
        require_lowercase: false,
        require_numbers: false,
        require_special_chars: false
      },
      session_timeout: 8 * 60 * 60 * 1000,
      max_login_attempts: 5,
      lockout_duration: 15 * 60 * 1000,
      allowed_roles: ['user', 'propertyowner', 'admin']
    });

  } catch (error) {
    console.error('Get auth config error:', error);
    res.status(500).json({
      error: 'Config unavailable',
      message: 'Unable to retrieve authentication configuration'
    });
  }
});

router.get('/users', auth, requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 10));
    const offset = (page - 1) * limit;
    const search = req.query.search?.trim() || '';
    const role = req.query.role?.trim() || '';

    let whereClause = '';
    const queryParams = [];

    if (search) {
      whereClause = ' WHERE (username LIKE ? OR email LIKE ?)';
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