const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const db = require('../config/db');

// Endpoint to set/update favourite status
router.post('/favourite', auth, (req, res) => {
    const { property_id, isFavourite } = req.body;
    const user_id = req.user.id;
  
    // Check if an interaction record already exists for this user and property.
    db.query(
      'SELECT * FROM user_property_interactions WHERE user_id = ? AND property_id = ?',
      [user_id, property_id],
      (err, results) => {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: 'Error querying interactions' });
        }  
        if (results.length > 0) {
          // Update the existing record.
          db.query(
            'UPDATE user_property_interactions SET isFavourite = ? WHERE user_id = ? AND property_id = ?',
            [isFavourite, user_id, property_id],
            (err, results) => {
              if (err) {
                console.error(err);
                return res.status(500).json({ error: 'Error updating favourite status' });
              }
              return res.json({ msg: 'Favourite status updated successfully' });
            }
          );
        } else {
          // Insert a new interaction record.
          db.query(
            'INSERT INTO user_property_interactions (user_id, property_id, isFavourite) VALUES (?, ?, ?)',
            [user_id, property_id, isFavourite],
            (err, results) => {
              if (err) {
                console.error(err);
                return res.status(500).json({ error: 'Error inserting favourite status' });
              }
              return res.status(201).json({ msg: 'Favourite status set successfully' });
            }
          );
        }
      }
    );
});

router.get('/favourite/:id', auth, (req, res) => {
    const user_id = req.user.id;
    const property_id = req.params.id;
  
    db.query(
      'SELECT isFavourite FROM user_property_interactions WHERE user_id = ? AND property_id = ?',
      [user_id, property_id],
      (err, results) => {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: 'Error querying interactions' });
        }
        if (results.length > 0) {
          return res.json(results[0]);
        }
        return res.json({ isFavourite: false });
      }
    );
});

  // get all favourite properties
  router.get('/favourite', auth, (req, res) => {
    const user_id = req.user.id;
    const query = `
        SELECT pd.* 
        FROM property_details pd
        INNER JOIN user_property_interactions upi 
        ON pd.id = upi.property_id
        WHERE upi.user_id = ? AND upi.isFavourite = 1
    `;

    db.query(query, [user_id], (err, results) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Error querying favourite properties' });
        }
        res.json(results);
    });
});

  
  // Endpoint to submit/update a complaint
  router.post('/complaint', auth, (req, res) => {
    const { property_id, complaint } = req.body;
    const user_id = req.user.id;
  
    // Check if an interaction record already exists.
    db.query(
      'SELECT * FROM user_property_interactions WHERE user_id = ? AND property_id = ?',
      [user_id, property_id],
      (err, results) => {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: 'Error querying interactions' });
        }
        if (results.length > 0) {
          // Update the existing record with the complaint.
          db.query(
            'UPDATE user_property_interactions SET complaint = ? WHERE user_id = ? AND property_id = ?',
            [complaint, user_id, property_id],
            (err, results) => {
              if (err) {
                console.error(err);
                return res.status(500).json({ error: 'Error updating complaint' });
              }
              return res.json({ msg: 'Complaint updated successfully' });
            }
          );
        } else {
          // Insert a new interaction record with the complaint.
          db.query(
            'INSERT INTO user_property_interactions (user_id, property_id, complaint) VALUES (?, ?, ?)',
            [user_id, property_id, complaint],
            (err, results) => {
              if (err) {
                console.error(err);
                return res.status(500).json({ error: 'Error inserting complaint' });
              }
              return res.status(201).json({ msg: 'Complaint submitted successfully' });
            }
          );
        }
      }
    );
  });
  
  // Endpoint for a property owner to fetch complaints on properties they own
  router.get('/complaints', auth, (req, res) => {
    const owner_id = req.user.id;
    // Join user_property_interactions with property_details to get complaints for properties owned by this user.
    const query = `
      SELECT upi.*, pd.property_type, pd.unit_type
      FROM user_property_interactions upi
      INNER JOIN property_details pd ON upi.property_id = pd.id
      WHERE pd.user_id = ? 
        AND upi.complaint IS NOT NULL 
        AND upi.complaint <> ''
      ORDER BY upi.created_at DESC
    `;
    db.query(query, [owner_id], (err, results) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Error fetching complaints' });
      }
      res.json(results);
    });
  });

  module.exports = router;