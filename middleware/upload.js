const { v2: cloudinary } = require('cloudinary');
const multer = require('multer');
const path = require('path');
require('dotenv').config();

cloudinary.config({ 
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME, 
  api_key: process.env.CLOUDINARY_API_KEY, 
  api_secret: process.env.CLOUDINARY_API_SECRET 
});

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only images and documents are allowed.'));
    }
  }
});

const uploadToCloudinary = (fileBuffer, originalName) => {
  return new Promise((resolve, reject) => {
    const filename = Date.now() + path.extname(originalName);
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        public_id: filename,
        folder: 'staywise_images',
        resource_type: 'auto'
      },
      (error, result) => {
        if (error) {
          console.error('Cloudinary Upload Error:', error);
          return reject(error);
        }
        resolve(result);
      }
    );
    
    uploadStream.on('error', (err) => {
      console.error('Cloudinary Upload Stream Error:', err);
      reject(err);
    });
    
    uploadStream.end(fileBuffer);
  });
};

module.exports = { upload, uploadToCloudinary };