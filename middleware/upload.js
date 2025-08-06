const multer = require('multer');
const { BlobServiceClient } = require('@azure/storage-blob');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Azure Storage configuration
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING || 
  'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;';

const CONTAINER_NAME = process.env.AZURE_CONTAINER_NAME || 'staywise-uploads';

// Initialize Azure Blob Service Client
let blobServiceClient;
try {
  blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
} catch (error) {
  console.error('Error initializing Azure Blob Service Client:', error);
  blobServiceClient = null;
}

// Configure multer for temporary file storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadPath = 'temp-uploads';
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const sanitizedOriginalName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(sanitizedOriginalName));
  }
});

// File filter for allowed types
const fileFilter = (req, file, cb) => {
  const allowedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
  const allowedDocTypes = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
  const allowedTypes = [...allowedImageTypes, ...allowedDocTypes];
  
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type: ${file.mimetype}. Only images (JPEG, PNG, GIF, WebP) and documents (PDF, DOC, DOCX) are allowed.`), false);
  }
};

// Multer configuration
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB per file
    files: 10 // Maximum 10 files per upload
  }
});

/**
 * Upload file to Azure Blob Storage
 * @param {Object} file - Multer file object
 * @param {string} folder - Folder name in container (optional)
 * @returns {Promise<Object>} Upload result with URL and metadata
 */
const uploadToAzure = async (file, folder = 'general') => {
  if (!blobServiceClient) {
    throw new Error('Azure Blob Service Client not initialized');
  }

  try {
    const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
    
    // Ensure container exists
    try {
      await containerClient.createIfNotExists({
        access: 'blob' // Allow public read access to blobs
      });
    } catch (error) {
      console.warn('Container creation warning:', error.message);
    }

    // Generate unique blob name
    const fileExtension = path.extname(file.originalname);
    const timestamp = Date.now();
    const randomString = crypto.randomBytes(8).toString('hex');
    const blobName = `${folder}/${timestamp}-${randomString}${fileExtension}`;

    // Get block blob client
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    // Set content type
    const contentType = file.mimetype || 'application/octet-stream';

    // Upload file buffer or stream
    let uploadResponse;
    if (file.buffer) {
      // If file is in memory (buffer)
      uploadResponse = await blockBlobClient.upload(file.buffer, file.buffer.length, {
        blobHTTPHeaders: {
          blobContentType: contentType
        }
      });
    } else if (file.path) {
      // If file is stored temporarily on disk
      const fileBuffer = fs.readFileSync(file.path);
      uploadResponse = await blockBlobClient.upload(fileBuffer, fileBuffer.length, {
        blobHTTPHeaders: {
          blobContentType: contentType
        }
      });
      
      // Clean up temporary file
      try {
        fs.unlinkSync(file.path);
      } catch (error) {
        console.warn('Error deleting temporary file:', error.message);
      }
    } else {
      throw new Error('No file buffer or path available');
    }

    // Construct public URL
    const baseUrl = blobServiceClient.url.replace(/\/$/, '');
    const blobUrl = `${baseUrl}/${CONTAINER_NAME}/${blobName}`;

    return {
      url: blobUrl,
      blobName: blobName,
      container: CONTAINER_NAME,
      filename: file.filename || file.originalname,
      originalname: file.originalname,
      mimetype: contentType,
      size: file.size,
      uploadResponse: uploadResponse
    };

  } catch (error) {
    console.error('Error uploading to Azure:', error);
    
    // Clean up temporary file if it exists
    if (file.path && fs.existsSync(file.path)) {
      try {
        fs.unlinkSync(file.path);
      } catch (cleanupError) {
        console.warn('Error cleaning up temporary file:', cleanupError.message);
      }
    }
    
    throw new Error(`File upload failed: ${error.message}`);
  }
};

/**
 * Delete file from Azure Blob Storage
 * @param {string} blobName - Name of blob to delete
 * @returns {Promise<boolean>} Success status
 */
const deleteFromAzure = async (blobName) => {
  if (!blobServiceClient) {
    console.warn('Azure Blob Service Client not initialized');
    return false;
  }

  try {
    const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    
    const deleteResponse = await blockBlobClient.deleteIfExists();
    return deleteResponse.succeeded;
  } catch (error) {
    console.error('Error deleting from Azure:', error);
    return false;
  }
};

/**
 * Middleware to handle file upload errors
 */
const handleUploadError = (error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    switch (error.code) {
      case 'LIMIT_FILE_SIZE':
        return res.status(400).json({
          error: 'File too large',
          message: 'File size cannot exceed 10MB'
        });
      case 'LIMIT_FILE_COUNT':
        return res.status(400).json({
          error: 'Too many files',
          message: 'Maximum 10 files allowed per upload'
        });
      case 'LIMIT_UNEXPECTED_FILE':
        return res.status(400).json({
          error: 'Unexpected field',
          message: 'Unexpected file field in upload'
        });
      default:
        return res.status(400).json({
          error: 'Upload error',
          message: error.message
        });
    }
  }
  
  if (error.message && error.message.includes('Invalid file type')) {
    return res.status(400).json({
      error: 'Invalid file type',
      message: error.message
    });
  }
  
  return res.status(500).json({
    error: 'Server error',
    message: 'An unexpected error occurred during file upload'
  });
};

/**
 * Validate image dimensions (optional middleware)
 */
const validateImageDimensions = (req, res, next) => {
  if (!req.file && !req.files) {
    return next();
  }
  
  const files = req.files ? (Array.isArray(req.files) ? req.files : Object.values(req.files).flat()) : [req.file];
  
  for (const file of files) {
    if (file && file.mimetype && file.mimetype.startsWith('image/')) {
      const sizeInMB = file.size / (1024 * 1024);
      if (sizeInMB > 10) {
        return res.status(400).json({
          error: 'File too large',
          message: `File ${file.originalname} is ${sizeInMB.toFixed(2)}MB. Maximum size is 10MB.`
        });
      }
      
      // Additional image-specific validations can be added here
      // For example, checking minimum dimensions, aspect ratio, etc.
    }
  }
  
  next();
};

/**
 * Pre-configured upload middleware variants
 */
const uploadProfileImage = upload.single('profileImage');
const uploadPropertyImages = upload.array('propertyImages', 10);
const uploadMultipleFiles = upload.fields([
  { name: 'profileImage', maxCount: 1 },
  { name: 'propertyImages', maxCount: 10 },
  { name: 'documents', maxCount: 5 }
]);

/**
 * Process uploaded files and upload to Azure
 * This middleware should be used after multer middleware
 */
const processFileUpload = async (req, res, next) => {
  try {
    if (req.file) {
      // Single file upload
      req.uploadedFile = await uploadToAzure(req.file, 'profiles');
    } else if (req.files) {
      // Multiple files upload
      req.uploadedFiles = {};
      
      if (Array.isArray(req.files)) {
        // Files from upload.array()
        req.uploadedFiles.files = [];
        for (const file of req.files) {
          const result = await uploadToAzure(file, 'properties');
          req.uploadedFiles.files.push(result);
        }
      } else {
        // Files from upload.fields()
        for (const fieldname in req.files) {
          req.uploadedFiles[fieldname] = [];
          const folder = fieldname === 'profileImage' ? 'profiles' : 
                        fieldname === 'propertyImages' ? 'properties' : 'documents';
          
          for (const file of req.files[fieldname]) {
            const result = await uploadToAzure(file, folder);
            req.uploadedFiles[fieldname].push(result);
          }
        }
      }
    }
    
    next();
  } catch (error) {
    console.error('Error in processFileUpload middleware:', error);
    return res.status(500).json({
      error: 'Upload processing failed',
      message: 'Failed to process uploaded files. Please try again.'
    });
  }
};

/**
 * Cleanup temporary files middleware
 * Should be used as error middleware or cleanup
 */
const cleanupTempFiles = (req, res, next) => {
  const files = req.files ? (Array.isArray(req.files) ? req.files : Object.values(req.files).flat()) : 
                req.file ? [req.file] : [];
  
  files.forEach(file => {
    if (file.path && fs.existsSync(file.path)) {
      try {
        fs.unlinkSync(file.path);
      } catch (error) {
        console.warn('Error cleaning up temporary file:', error.message);
      }
    }
  });
  
  next();
};

/**
 * Health check for Azure Blob Storage
 */
const checkAzureConnection = async () => {
  if (!blobServiceClient) {
    return { status: 'error', message: 'Azure Blob Service Client not initialized' };
  }

  try {
    const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
    await containerClient.getProperties();
    return { status: 'healthy', message: 'Azure Blob Storage connected' };
  } catch (error) {
    return { status: 'error', message: `Azure connection failed: ${error.message}` };
  }
};

/**
 * Get file info from Azure
 * @param {string} blobName - Name of blob
 * @returns {Promise<Object>} File properties
 */
const getFileInfo = async (blobName) => {
  if (!blobServiceClient) {
    throw new Error('Azure Blob Service Client not initialized');
  }

  try {
    const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    
    const properties = await blockBlobClient.getProperties();
    const baseUrl = blobServiceClient.url.replace(/\/$/, '');
    const blobUrl = `${baseUrl}/${CONTAINER_NAME}/${blobName}`;
    
    return {
      url: blobUrl,
      blobName: blobName,
      contentType: properties.contentType,
      contentLength: properties.contentLength,
      lastModified: properties.lastModified,
      etag: properties.etag
    };
  } catch (error) {
    console.error('Error getting file info:', error);
    throw new Error(`Failed to get file info: ${error.message}`);
  }
};

/**
 * Generate signed URL for temporary access (if needed)
 * @param {string} blobName - Name of blob
 * @param {number} expiryHours - Hours until expiry (default 1)
 * @returns {Promise<string>} Signed URL
 */
const generateSignedUrl = async (blobName, expiryHours = 1) => {
  if (!blobServiceClient) {
    throw new Error('Azure Blob Service Client not initialized');
  }

  try {
    const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    
    const expiryDate = new Date();
    expiryDate.setHours(expiryDate.getHours() + expiryHours);
    
    // For now, return the public URL
    const baseUrl = blobServiceClient.url.replace(/\/$/, '');
    return `${baseUrl}/${CONTAINER_NAME}/${blobName}`;
  } catch (error) {
    console.error('Error generating signed URL:', error);
    throw new Error(`Failed to generate signed URL: ${error.message}`);
  }
};

module.exports = {
  upload,
  uploadToAzure,
  deleteFromAzure,
  handleUploadError,
  validateImageDimensions,
  uploadProfileImage,
  uploadPropertyImages,
  uploadMultipleFiles,
  processFileUpload,
  cleanupTempFiles,
  checkAzureConnection,
  getFileInfo,
  generateSignedUrl
};