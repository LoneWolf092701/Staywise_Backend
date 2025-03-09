const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');

router.post('/register', (req, res) => {
  const { username, password, role } = req.body;
  // Default role is 'user' if none is provided
  const userRole = role || 'user';
  
  const salt = bcrypt.genSaltSync(10);
  const hashedPassword = bcrypt.hashSync(password, salt);

  db.query(
    'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
    [username, hashedPassword, userRole],
    (err, results) => {
      if (err) return res.status(500).json({ error: err });
      res.status(201).json({ 
        msg: 'User registered', 
        user: { id: results.insertId, username, role: userRole } 
      });
    }
  );
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;

  db.query('SELECT * FROM users WHERE username = ?', [username], (err, results) => {
    if (err) return res.status(500).json({ error: err });
    if (results.length === 0)
      return res.status(400).json({ msg: 'Invalid credentials' });

    const user = results[0];
    const isMatch = bcrypt.compareSync(password, user.password);
    if (!isMatch)
      return res.status(400).json({ msg: 'Invalid credentials' });

    // Include role in the payload
    const payload = { user: { id: user.id, username: user.username, role: user.role } };

    jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' }, (err, token) => {
      if (err) throw err;
      // Return both the token and the user object with role
      res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
    });
  });
});

module.exports = router;
