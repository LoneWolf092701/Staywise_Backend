const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const auth = require('../middleware/auth');

// Helper function to validate email format
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Helper function to validate password strength
function isValidPassword(password) {
  return password && password.length >= 6;
}

/**
 * POST /api/auth/register
 * Register a new user account
 */
router.post('/register', async (req, res) => {
  try {
    const { username, email, password, role } = req.body;
    
    // Validate input
    if (!username || !email || !password) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        message: 'Username, email, and password are required'
      });
    }

    if (username.trim().length < 3) {
      return res.status(400).json({ 
        error: 'Invalid username',
        message: 'Username must be at least 3 characters long'
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ 
        error: 'Invalid email',
        message: 'Please provide a valid email address'
      });
    }

    if (!isValidPassword(password)) {
      return res.status(400).json({ 
        error: 'Invalid password',
        message: 'Password must be at least 6 characters long'
      });
    }

    // Default role is 'user' if none is provided
    const userRole = role && ['user', 'propertyowner'].includes(role) ? role : 'user';

    // Check if username or email already exists
    const checkExistingQuery = 'SELECT id, username, email FROM users WHERE username = ? OR email = ?';
    
    db.query(checkExistingQuery, [username, email], async (err, results) => {
      if (err) {
        console.error('Error checking existing user:', err);
        return res.status(500).json({ 
          error: 'Database error',
          message: 'Error checking user existence'
        });
      }

      if (results.length > 0) {
        const existingUser = results[0];
        if (existingUser.username === username) {
          return res.status(409).json({ 
            error: 'Username already exists',
            message: 'Please choose a different username'
          });
        }
        if (existingUser.email === email) {
          return res.status(409).json({ 
            error: 'Email already exists',
            message: 'An account with this email already exists'
          });
        }
      }

      try {
        // Hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Insert new user
        const insertQuery = 'INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)';
        
        db.query(insertQuery, [username.trim(), email.trim().toLowerCase(), hashedPassword, userRole], (err, results) => {
          if (err) {
            console.error('Error creating user:', err);
            return res.status(500).json({ 
              error: 'Database error',
              message: 'Error creating user account'
            });
          }

          const newUserId = results.insertId;
          
          res.status(201).json({ 
            message: 'User registered successfully',
            user: { 
              id: newUserId, 
              username: username.trim(), 
              email: email.trim().toLowerCase(),
              role: userRole 
            }
          });
        });

      } catch (hashError) {
        console.error('Error hashing password:', hashError);
        return res.status(500).json({ 
          error: 'Server error',
          message: 'Error processing registration'
        });
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ 
      error: 'Server error',
      message: 'Internal server error during registration'
    });
  }
});

/**
 * POST /api/auth/login
 * Authenticate user and return JWT token
 */
router.post('/login', (req, res) => {
  try {
    const { username, password } = req.body;

    // Validate input
    if (!username || !password) {
      return res.status(400).json({ 
        error: 'Missing credentials',
        message: 'Username and password are required'
      });
    }

    // Find user by username or email
    const findUserQuery = 'SELECT * FROM users WHERE username = ? OR email = ?';
    
    db.query(findUserQuery, [username.trim(), username.trim().toLowerCase()], async (err, results) => {
      if (err) {
        console.error('Error finding user:', err);
        return res.status(500).json({ 
          error: 'Database error',
          message: 'Error during authentication'
        });
      }

      if (results.length === 0) {
        return res.status(401).json({ 
          error: 'Invalid credentials',
          message: 'Username or password is incorrect'
        });
      }

      const user = results[0];

      try {
        // Verify password
        const isMatch = await bcrypt.compare(password, user.password);
        
        if (!isMatch) {
          return res.status(401).json({ 
            error: 'Invalid credentials',
            message: 'Username or password is incorrect'
          });
        }

        // Check if user account is active (if you have account status)
        // Add this check if you implement account status functionality

        // Create JWT payload
        const payload = { 
          user: { 
            id: user.id, 
            username: user.username,
            email: user.email,
            role: user.role 
          } 
        };

        // Sign JWT token
        const jwtSecret = process.env.JWT_SECRET;
        if (!jwtSecret) {
          console.error('JWT_SECRET not configured');
          return res.status(500).json({ 
            error: 'Server configuration error',
            message: 'Authentication service not properly configured'
          });
        }

        jwt.sign(payload, jwtSecret, { expiresIn: '8h' }, (err, token) => {
          if (err) {
            console.error('Error signing JWT:', err);
            return res.status(500).json({ 
              error: 'Token generation error',
              message: 'Error generating authentication token'
            });
          }

          // Update last login time
          const updateLoginQuery = 'UPDATE users SET last_login = NOW() WHERE id = ?';
          db.query(updateLoginQuery, [user.id], (updateErr) => {
            if (updateErr) {
              console.error('Error updating last login:', updateErr);
              // Don't fail the login for this error
            }
          });

          // Return token and user info
          res.json({ 
            message: 'Login successful',
            token, 
            user: { 
              id: user.id, 
              username: user.username,
              email: user.email,
              role: user.role 
            },
            expiresIn: '8h'
          });
        });

      } catch (compareError) {
        console.error('Error comparing password:', compareError);
        return res.status(500).json({ 
          error: 'Authentication error',
          message: 'Error verifying credentials'
        });
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ 
      error: 'Server error',
      message: 'Internal server error during login'
    });
  }
});

/**
 * POST /api/auth/forgot-password
 * Initiate password reset process
 */
router.post('/forgot-password', (req, res) => {
  const { email } = req.body;

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ 
      error: 'Invalid email',
      message: 'Please provide a valid email address'
    });
  }

  // Check if user exists
  const findUserQuery = 'SELECT id, username, email FROM users WHERE email = ?';
  
  db.query(findUserQuery, [email.trim().toLowerCase()], (err, results) => {
    if (err) {
      console.error('Error finding user for password reset:', err);
      return res.status(500).json({ 
        error: 'Database error',
        message: 'Error processing password reset request'
      });
    }

    // Always return success message for security (don't reveal if email exists)
    const successMessage = 'If an account with this email exists, you will receive password reset instructions';

    if (results.length === 0) {
      return res.json({ message: successMessage });
    }

    const user = results[0];

    // Generate reset token
    const resetToken = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    // Store reset token in database (you may want to create a password_resets table)
    const storeTokenQuery = `
      INSERT INTO user_profiles (user_id, password_reset_token, password_reset_expires, updated_at)
      VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR), NOW())
      ON DUPLICATE KEY UPDATE 
      password_reset_token = VALUES(password_reset_token),
      password_reset_expires = VALUES(password_reset_expires),
      updated_at = NOW()
    `;

    db.query(storeTokenQuery, [user.id, resetToken], (err) => {
      if (err) {
        console.error('Error storing reset token:', err);
        return res.status(500).json({ 
          error: 'Database error',
          message: 'Error processing password reset request'
        });
      }

      // In a real application, you would send an email here
      // For now, we'll just return the token (remove this in production)
      res.json({ 
        message: successMessage,
        // Remove this in production - only for testing
        resetToken: resetToken
      });
    });
  });
});

/**
 * POST /api/auth/reset-password
 * Reset password using reset token
 */
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword, confirmPassword } = req.body;

    if (!token || !newPassword || !confirmPassword) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        message: 'Reset token, new password, and confirmation are required'
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ 
        error: 'Password mismatch',
        message: 'New password and confirmation must match'
      });
    }

    if (!isValidPassword(newPassword)) {
      return res.status(400).json({ 
        error: 'Invalid password',
        message: 'Password must be at least 6 characters long'
      });
    }

    try {
      // Verify reset token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const userId = decoded.userId;

      // Check if token is still valid in database
      const checkTokenQuery = `
        SELECT user_id FROM user_profiles 
        WHERE user_id = ? AND password_reset_token = ? AND password_reset_expires > NOW()
      `;

      db.query(checkTokenQuery, [userId, token], async (err, results) => {
        if (err) {
          console.error('Error checking reset token:', err);
          return res.status(500).json({ 
            error: 'Database error',
            message: 'Error verifying reset token'
          });
        }

        if (results.length === 0) {
          return res.status(400).json({ 
            error: 'Invalid or expired token',
            message: 'Reset token is invalid or has expired'
          });
        }

        try {
          // Hash new password
          const salt = await bcrypt.genSalt(10);
          const hashedPassword = await bcrypt.hash(newPassword, salt);

          // Update password and clear reset token
          const updatePasswordQuery = 'UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?';
          
          db.query(updatePasswordQuery, [hashedPassword, userId], (err) => {
            if (err) {
              console.error('Error updating password:', err);
              return res.status(500).json({ 
                error: 'Database error',
                message: 'Error updating password'
              });
            }

            // Clear reset token
            const clearTokenQuery = `
              UPDATE user_profiles 
              SET password_reset_token = NULL, password_reset_expires = NULL, updated_at = NOW()
              WHERE user_id = ?
            `;

            db.query(clearTokenQuery, [userId], (err) => {
              if (err) {
                console.error('Error clearing reset token:', err);
                // Don't fail the request for this error
              }

              res.json({ 
                message: 'Password reset successfully',
                success: true
              });
            });
          });

        } catch (hashError) {
          console.error('Error hashing new password:', hashError);
          return res.status(500).json({ 
            error: 'Server error',
            message: 'Error processing password reset'
          });
        }
      });

    } catch (jwtError) {
      console.error('Error verifying reset token:', jwtError);
      return res.status(400).json({ 
        error: 'Invalid token',
        message: 'Reset token is invalid or has expired'
      });
    }

  } catch (error) {
    console.error('Password reset error:', error);
    res.status(500).json({ 
      error: 'Server error',
      message: 'Internal server error during password reset'
    });
  }
});

/**
 * GET /api/auth/verify-token
 * Verify if the current token is valid
 */
router.get('/verify-token', auth, (req, res) => {
  // If we reach here, the token is valid (auth middleware passed)
  res.json({ 
    valid: true,
    user: {
      id: req.user.id,
      username: req.user.username,
      role: req.user.role
    }
  });
});

/**
 * POST /api/auth/logout
 * Logout user (client-side token removal)
 */
router.post('/logout', auth, (req, res) => {
  // In a stateless JWT system, logout is handled client-side
  // You could implement token blacklisting here if needed
  
  res.json({ 
    message: 'Logged out successfully',
    success: true
  });
});

/**
 * POST /api/auth/change-password
 * Change password for authenticated user
 */
router.post('/change-password', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        message: 'Current password, new password, and confirmation are required'
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ 
        error: 'Password mismatch',
        message: 'New password and confirmation must match'
      });
    }

    if (!isValidPassword(newPassword)) {
      return res.status(400).json({ 
        error: 'Invalid password',
        message: 'New password must be at least 6 characters long'
      });
    }

    // Get current password
    const getUserQuery = 'SELECT password FROM users WHERE id = ?';
    
    db.query(getUserQuery, [userId], async (err, results) => {
      if (err) {
        console.error('Error fetching user for password change:', err);
        return res.status(500).json({ 
          error: 'Database error',
          message: 'Error verifying current password'
        });
      }

      if (results.length === 0) {
        return res.status(404).json({ 
          error: 'User not found',
          message: 'User account not found'
        });
      }

      const user = results[0];

      try {
        // Verify current password
        const isMatch = await bcrypt.compare(currentPassword, user.password);
        
        if (!isMatch) {
          return res.status(401).json({ 
            error: 'Invalid current password',
            message: 'Current password is incorrect'
          });
        }

        // Hash new password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        // Update password
        const updateQuery = 'UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?';
        
        db.query(updateQuery, [hashedPassword, userId], (err) => {
          if (err) {
            console.error('Error updating password:', err);
            return res.status(500).json({ 
              error: 'Database error',
              message: 'Error updating password'
            });
          }

          res.json({ 
            message: 'Password changed successfully',
            success: true
          });
        });

      } catch (compareError) {
        console.error('Error verifying current password:', compareError);
        return res.status(500).json({ 
          error: 'Server error',
          message: 'Error verifying current password'
        });
      }
    });

  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ 
      error: 'Server error',
      message: 'Internal server error during password change'
    });
  }
});

module.exports = router;