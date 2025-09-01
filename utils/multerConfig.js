const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '../uploads');
const bookingDocsDir = path.join(uploadsDir, 'booking-documents');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

if (!fs.existsSync(bookingDocsDir)) {
  fs.mkdirSync(bookingDocsDir, { recursive: true });
}

// Storage configuration for booking documents
const bookingDocumentStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, bookingDocsDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const fileExtension = path.extname(file.originalname);
    const fieldName = file.fieldname; // 'paymentReceipt' or 'nicPhoto'
    const bookingId = req.params.id || 'unknown';
    
    cb(null, `${fieldName}-${bookingId}-${uniqueSuffix}${fileExtension}`);
  }
});

// File filter for booking documents
const bookingDocumentFilter = (req, file, cb) => {
  // Check file type
  if (!file.mimetype.startsWith('image/')) {
    return cb(new Error('Only image files are allowed!'), false);
  }

  // Check file extension
  const allowedExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
  const fileExtension = path.extname(file.originalname).toLowerCase();
  
  if (!allowedExtensions.includes(fileExtension)) {
    return cb(new Error('Invalid file extension. Only JPG, JPEG, PNG, and WEBP are allowed.'), false);
  }

  // Validate field names for booking documents
  if (file.fieldname !== 'paymentReceipt' && file.fieldname !== 'nicPhoto') {
    return cb(new Error('Invalid field name. Expected paymentReceipt or nicPhoto.'), false);
  }

  cb(null, true);
};

// Multer instance for booking documents
const uploadBookingDocuments = multer({
  storage: bookingDocumentStorage,
  fileFilter: bookingDocumentFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB per file
    files: 2 // Maximum 2 files (receipt + NIC)
  }
});

// Storage configuration for property images (existing)
const propertyImageStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const propertyImagesDir = path.join(uploadsDir, 'properties');
    if (!fs.existsSync(propertyImagesDir)) {
      fs.mkdirSync(propertyImagesDir, { recursive: true });
    }
    cb(null, propertyImagesDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const fileExtension = path.extname(file.originalname);
    cb(null, `property-${uniqueSuffix}${fileExtension}`);
  }
});

// File filter for property images (existing)
const propertyImageFilter = (req, file, cb) => {
  if (!file.mimetype.startsWith('image/')) {
    return cb(new Error('Only image files are allowed!'), false);
  }

  const allowedExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
  const fileExtension = path.extname(file.originalname).toLowerCase();
  
  if (!allowedExtensions.includes(fileExtension)) {
    return cb(new Error('Invalid file extension. Only JPG, JPEG, PNG, and WEBP are allowed.'), false);
  }

  cb(null, true);
};

// Multer instance for property images
const uploadPropertyImages = multer({
  storage: propertyImageStorage,
  fileFilter: propertyImageFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB per file
    files: 10 // Maximum 10 property images
  }
});

// Storage configuration for profile images (existing)
const profileImageStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const profileImagesDir = path.join(uploadsDir, 'profiles');
    if (!fs.existsSync(profileImagesDir)) {
      fs.mkdirSync(profileImagesDir, { recursive: true });
    }
    cb(null, profileImagesDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const fileExtension = path.extname(file.originalname);
    cb(null, `profile-${uniqueSuffix}${fileExtension}`);
  }
});

// Multer instance for profile images
const uploadProfileImage = multer({
  storage: profileImageStorage,
  fileFilter: propertyImageFilter, // Same filter as property images
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB for profile images
    files: 1
  }
});

module.exports = {
  uploadBookingDocuments,
  uploadPropertyImages,
  uploadProfileImage,
  uploadsDir,
  bookingDocsDir
};