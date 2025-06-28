const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const db = require('../config/db');
const { upload, uploadToGCS } = require('../middleware/upload');

router.post('/', auth, (req, res) => {
  const { title, description, price, location } = req.body;
  const userId = req.user.id; 

  db.query(
    'INSERT INTO properties (user_id, title, description, price, location) VALUES (?, ?, ?, ?, ?)',
    [userId, title, description, price, location],
    (err, results) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Error adding property' });
      }
      res.status(201).json({ msg: 'Property added successfully', propertyId: results.insertId });
    }
  );
});

router.get('/', auth, (req, res) => {
  const userId = req.user.id;

  db.query('SELECT * FROM properties WHERE user_id = ?', [userId], (err, results) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Error fetching properties' });
    }
    res.json(results);
  });
});

router.put('/:id', auth, (req, res) => {
  const { title, description, price, location } = req.body;
  const propertyId = req.params.id;
  const userId = req.user.id;

  db.query(
    'SELECT * FROM properties WHERE id = ? AND user_id = ?',
    [propertyId, userId],
    (err, results) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Error finding property' });
      }
      if (results.length === 0) {
        return res.status(404).json({ error: 'Property not found or not owned by user' });
      }

      db.query(
        'UPDATE properties SET title = ?, description = ?, price = ?, location = ? WHERE id = ?',
        [title, description, price, location, propertyId],
        (err, results) => {
          if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Error updating property' });
          }
          res.json({ msg: 'Property updated successfully' });
        }
      );
    }
  );
});

router.delete('/:id', auth, (req, res) => {
  const propertyId = req.params.id;
  const userId = req.user.id;

  db.query(
    'SELECT * FROM properties WHERE id = ? AND user_id = ?',
    [propertyId, userId],
    (err, results) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Error finding property' });
      }
      if (results.length === 0) {
        return res.status(404).json({ error: 'Property not found or not owned by user' });
      }

      db.query('DELETE FROM properties WHERE id = ?', [propertyId], (err, results) => {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: 'Error deleting property' });
        }
        res.json({ msg: 'Property deleted successfully' });
      });
    }
  );
});

router.post('/details', auth, (req, res) => {
  const {
    propertyType,
    unitType,
    selectedAmenities,
    facilities,
    otherFacility,
    roommates,
    rules,
    contractPolicy,
    address,
    availableFrom,
    availableTo,
    priceRange,
    billsInclusive
  } = req.body;
  const userId = req.user.id;

  // Prepare the data for both tables.
  const propertyData = [
    userId,
    propertyType,
    unitType,
    JSON.stringify(selectedAmenities),
    JSON.stringify(facilities),
    otherFacility,
    JSON.stringify(roommates),
    JSON.stringify(rules),
    contractPolicy,
    address,
    availableFrom,
    availableTo,
    JSON.stringify(priceRange),
    JSON.stringify(billsInclusive)
  ];

  // First, insert into property_details.
  db.query(
    `INSERT INTO property_details 
      (user_id, property_type, unit_type, amenities, facilities, other_facility, roommates, rules, contract_policy, address, available_from, available_to, price_range, bills_inclusive) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    propertyData,
    (err, results) => {
      if (err) {
        console.error('Error inserting property details:', err);
        return res.status(500).json({ error: 'Error adding property details' });
      }
      const insertedId = results.insertId;

      // Now, insert into all_properties using the same insertedId.
      db.query(
        `INSERT INTO all_properties 
          (id, user_id, property_type, unit_type, amenities, facilities, other_facility, roommates, rules, contract_policy, address, available_from, available_to, price_range, bills_inclusive) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          insertedId, // Use the same id from property_details.
          userId,
          propertyType,
          unitType,
          JSON.stringify(selectedAmenities),
          JSON.stringify(facilities),
          otherFacility,
          JSON.stringify(roommates),
          JSON.stringify(rules),
          contractPolicy,
          address,
          availableFrom,
          availableTo,
          JSON.stringify(priceRange),
          JSON.stringify(billsInclusive)
        ],
        (err, results) => {
          if (err) {
            console.error('Error inserting into all_properties:', err);
            return res.status(500).json({ error: 'Error adding property to all properties' });
          }
          // Send a single response after both insertions are successful.
          return res.status(201).json({ msg: 'Property details added successfully to both tables', propertyId: insertedId });
        }
      );
    }
  );
});

// to get all properties - property owner
router.get('/details', auth, (req, res) => {
  const userId = req.user.id;

  db.query(
    'SELECT * FROM property_details WHERE user_id = ? AND is_deleted = 0',
    [userId],
    (err, results) => {
      if (err) {
        console.error('Error fetching property details:', err);
        return res.status(500).json({ error: 'Error fetching properties' });
      }
      res.json(results);
    }
  );
});

// to get a property by id - property owner
router.get('/details/:id', auth, (req, res) => {
  const propertyId = req.params.id;
  const userId = req.user.id;

  // Query property_details to fetch the property if it belongs to the user and is not deleted.
  const query = 'SELECT * FROM property_details WHERE id = ? AND user_id = ? AND is_deleted = 0';
  db.query(query, [propertyId, userId], (err, results) => {
    if (err) {
      console.error('Error fetching property details:', err);
      return res.status(500).json({ error: 'Error fetching property details' });
    }
    if (results.length === 0) {
      return res.status(404).json({ error: 'Property not found or not owned by user' });
    }
    res.json(results[0]);
  });
});

// to update a property - property owner
router.put('/details/:id', auth, (req, res) => {
  const propertyId = req.params.id;
  const userId = req.user.id;
  const {
    propertyType,
    unitType,
    selectedAmenities,
    facilities,
    otherFacility,
    roommates,
    rules,
    contractPolicy,
    address,
    availableFrom,
    availableTo,
    priceRange,
    billsInclusive
  } = req.body;

  db.query(
    'SELECT * FROM property_details WHERE id = ? AND user_id = ? AND is_deleted = 0',
    [propertyId, userId],
    (err, results) => {
      if (err) {
        console.error('Error finding property details:', err);
        return res.status(500).json({ error: 'Error finding property details' });
      }
      if (results.length === 0) {
        return res.status(404).json({ error: 'Property details not found or not owned by user' });
      }

      db.query(
        `UPDATE property_details SET 
          property_type = ?,
          unit_type = ?,
          amenities = ?,
          facilities = ?,
          other_facility = ?,
          roommates = ?,
          rules = ?,
          contract_policy = ?,
          address = ?,
          available_from = ?,
          available_to = ?,
          price_range = ?,
          bills_inclusive = ?
         WHERE id = ?`,
        [
          propertyType,
          unitType,
          JSON.stringify(selectedAmenities),
          JSON.stringify(facilities),
          otherFacility,
          JSON.stringify(roommates),
          JSON.stringify(rules),
          contractPolicy,
          address,
          availableFrom,
          availableTo,
          JSON.stringify(priceRange),
          JSON.stringify(billsInclusive),
          propertyId
        ],
        (err, results) => {
          if (err) {
            console.error('Error updating property details:', err);
            return res.status(500).json({ error: 'Error updating property details' });
          }
          res.json({ msg: 'Property details updated successfully' });
        }
      );
    }
  );
});

router.delete('/details/:id', auth, (req, res) => {
  const propertyId = req.params.id;
  const userId = req.user.id;

  db.query(
    'SELECT * FROM property_details WHERE id = ? AND user_id = ? AND is_deleted = 0',
    [propertyId, userId],
    (err, results) => {
      if (err) {
        console.error('Error finding property details for deletion:', err);
        return res.status(500).json({ error: 'Error finding property details' });
      }
      if (results.length === 0) {
        return res.status(404).json({ error: 'Property details not found or already deleted or not owned by user' });
      }

      db.query(
        'UPDATE property_details SET is_deleted = 1 WHERE id = ?',
        [propertyId],
        (err, results) => {
          if (err) {
            console.error('Error soft deleting property details:', err);
            return res.status(500).json({ error: 'Error soft deleting property details' });
          }
          res.json({ msg: 'Property details soft-deleted successfully' });
        }
      );
    }
  );
});

// to get all properties
router.get('/all', (req, res) => {
  const query = `
    SELECT * FROM all_properties 
    WHERE is_active = 1 
    ORDER BY approved_at DESC
  `;
  
  db.query(query, (err, results) => {
    if (err) {
      console.error('Error fetching all properties:', err);
      return res.status(500).json({ error: 'Error fetching all properties' });
    }
  const processedResults = results.map(property => ({
      ...property,
      amenities: safeJsonParse(property.amenities),
      facilities: safeJsonParse(property.facilities),
      roommates: safeJsonParse(property.roommates),
      rules: safeJsonParse(property.rules),
      price_range: safeJsonParse(property.price_range),
      bills_inclusive: safeJsonParse(property.bills_inclusive)
    }));
    
    res.json(processedResults);
  });
});

// to get one property
router.get('/all/:id', (req, res) => {
  const propertyId = req.params.id;
  const query = `
    SELECT * FROM all_properties 
    WHERE id = ? AND is_active = 1
  `;
  
  db.query(query, [propertyId], (err, results) => {
    if (err) {
      console.error('Error fetching property detail:', err);
      return res.status(500).json({error: 'Error fetching property details'});
    }
    
    if (results.length === 0) {
      return res.status(404).json({error: 'Property not found or not available'});
    }
    
    // Process the single property result
    const processedResult = results.map(property => ({
      ...property,
      amenities: safeJsonParse(property.amenities),
      facilities: safeJsonParse(property.facilities),
      roommates: safeJsonParse(property.roommates),
      rules: safeJsonParse(property.rules),
      price_range: safeJsonParse(property.price_range),
      bills_inclusive: safeJsonParse(property.bills_inclusive)
    }));
    
    res.json(processedResult);
  })
});

router.post('/upload', auth, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  try {
    const result = await uploadToCloudinary(req.file.buffer, req.file.originalname);
    res.status(200).json({ cloudUrl: result.secure_url });
  } catch (error) {
    res.status(500).json({ error: 'Image upload failed', details: error });
  }
});

function safeJsonParse(jsonString) {
  if (!jsonString) return null;
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    console.warn('Invalid JSON string:', jsonString);
    return null;
  }
}

module.exports = router;
