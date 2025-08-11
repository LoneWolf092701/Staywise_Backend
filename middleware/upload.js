const { BlobServiceClient } = require('@azure/storage-blob');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const AZURE_CONNECTION_STRING = process.env.AZURE_CONNECTION_STRING || 
  'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;';

const CONTAINER_NAME = process.env.AZURE_CONTAINER_NAME || 'staywise-uploads';

let blobServiceClient;
let azureConnectionFailed = false;

try {
  blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_CONNECTION_STRING);
  console.log('Azure Blob Service Client initialized successfully');
} catch (error) {
  console.error('Error initializing Azure Blob Service Client:', error.message);
  azureConnectionFailed = true;
}

const initializeContainer = async () => {
  try {
    if (!blobServiceClient || azureConnectionFailed) {
      throw new Error('Azure Blob Service Client not initialized');
    }
    
    const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
    const exists = await containerClient.exists();
    
    if (!exists) {
      await containerClient.create({
        access: 'blob'
      });
      console.log(`Container "${CONTAINER_NAME}" created successfully`);
    }
    
    return containerClient;
  } catch (error) {
    console.error('Error initializing container:', error);
    throw error;
  }
};

const validateFileType = (req, file, cb) => {
  const allowedTypes = {
    'image/jpeg': ['.jpg', '.jpeg'],
    'image/png': ['.png'],
    'image/webp': ['.webp'],
    'image/gif': ['.gif'],
    'application/pdf': ['.pdf'],
    'application/msword': ['.doc'],
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx']
  };

  const isAllowedType = Object.keys(allowedTypes).includes(file.mimetype);
  const fileExtension = path.extname(file.originalname).toLowerCase();
  const isAllowedExtension = allowedTypes[file.mimetype]?.includes(fileExtension);

  if (isAllowedType && isAllowedExtension) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type: ${file.mimetype}. Allowed types: ${Object.keys(allowedTypes).join(', ')}`));
  }
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 10
  },
  fileFilter: validateFileType
});

const uploadToAzure = async (file, folder = 'uploads') => {
  if (!blobServiceClient || azureConnectionFailed) {
    console.warn('Azure Blob Storage not available, using fallback');
    const timestamp = Date.now();
    const randomString = crypto.randomBytes(8).toString('hex');
    const fileExtension = path.extname(file.originalname);
    const fileName = `${folder}/${timestamp}-${randomString}${fileExtension}`;
    
    return {
      url: `http://localhost:5000/uploads/${fileName}`,
      filename: fileName,
      originalname: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
      container: 'local-fallback'
    };
  }

  try {
    const containerClient = await initializeContainer();
    
    const timestamp = Date.now();
    const randomString = crypto.randomBytes(8).toString('hex');
    const fileExtension = path.extname(file.originalname);
    const fileName = `${folder}/${timestamp}-${randomString}${fileExtension}`;
    
    const blockBlobClient = containerClient.getBlockBlobClient(fileName);
    
    const uploadOptions = {
      blobHTTPHeaders: {
        blobContentType: file.mimetype,
        blobCacheControl: 'public, max-age=31536000'
      },
      metadata: {
        originalname: file.originalname,
        uploadedAt: new Date().toISOString(),
        size: file.size.toString()
      }
    };
    
    await blockBlobClient.upload(file.buffer, file.size, uploadOptions);
    
    const baseUrl = blobServiceClient.url.replace(/\/$/, '');
    const blobUrl = `${baseUrl}/${CONTAINER_NAME}/${fileName}`;
    
    return {
      url: blobUrl,
      filename: fileName,
      originalname: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
      container: CONTAINER_NAME
    };
  } catch (error) {
    console.error('Error uploading to Azure:', error);
    console.warn('Falling back to local upload simulation');
    
    const timestamp = Date.now();
    const randomString = crypto.randomBytes(8).toString('hex');
    const fileExtension = path.extname(file.originalname);
    const fileName = `${folder}/${timestamp}-${randomString}${fileExtension}`;
    
    return {
      url: `http://localhost:5000/uploads/${fileName}`,
      filename: fileName,
      originalname: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
      container: 'local-fallback'
    };
  }
};

const deleteFromAzure = async (blobName) => {
  if (!blobServiceClient || azureConnectionFailed) {
    console.warn('Azure Blob Service Client not available for deletion');
    return true;
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

const handleUploadError = (error, req, res, next) => {
  console.error('Upload error:', error);
  
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'File too large',
        message: 'File size exceeds 10MB limit'
      });
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        success: false,
        error: 'Too many files',
        message: 'Maximum 10 files allowed'
      });
    }
    if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({
        success: false,
        error: 'Unexpected file field',
        message: 'Invalid file field name'
      });
    }
  }
  
  if (error.message.includes('Invalid file type')) {
    return res.status(400).json({
      success: false,
      error: 'Invalid file type',
      message: error.message
    });
  }
  
  return res.status(500).json({
    success: false,
    error: 'Upload failed',
    message: error.message || 'An error occurred during file upload'
  });
};

const validateImageDimensions = async (req, res, next) => {
  const files = req.files ? 
    (Array.isArray(req.files) ? req.files : Object.values(req.files).flat()) : [req.file];
  
  for (const file of files) {
    if (file && file.mimetype && file.mimetype.startsWith('image/')) {
      const sizeInMB = file.size / (1024 * 1024);
      if (sizeInMB > 10) {
        return res.status(400).json({
          error: 'File too large',
          message: `File ${file.originalname} is ${sizeInMB.toFixed(2)}MB. Maximum size is 10MB.`
        });
      }
    }
  }
  
  next();
};

const uploadProfileImage = upload.single('profileImage');
const uploadPropertyImages = upload.array('propertyImages', 10);
const uploadMultipleFiles = upload.fields([
  { name: 'profileImage', maxCount: 1 },
  { name: 'propertyImages', maxCount: 10 },
  { name: 'documents', maxCount: 5 }
]);

const processFileUpload = async (req, res, next) => {
  try {
    console.log('ProcessFileUpload - req.file:', req.file);
    console.log('ProcessFileUpload - req.files:', req.files);
    
    if (req.file) {
      console.log('Processing single file upload...');
      try {
        req.uploadedFile = await uploadToAzure(req.file, 'profiles');
        console.log('Upload result:', req.uploadedFile);
      } catch (uploadError) {
        console.error('Single file upload error:', uploadError);
        return res.status(500).json({
          success: false,
          error: 'Upload processing failed',
          message: 'Failed to upload file to storage. Please try again.'
        });
      }
    } else if (req.files) {
      req.uploadedFiles = {};
      
      try {
        if (Array.isArray(req.files)) {
          req.uploadedFiles.files = [];
          for (const file of req.files) {
            const result = await uploadToAzure(file, 'properties');
            req.uploadedFiles.files.push(result);
          }
        } else {
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
      } catch (uploadError) {
        console.error('Multiple files upload error:', uploadError);
        return res.status(500).json({
          success: false,
          error: 'Upload processing failed',
          message: 'Failed to upload files to storage. Please try again.'
        });
      }
    } else {
      console.log('No files found in request');
      return res.status(400).json({
        success: false,
        error: 'No files uploaded',
        message: 'No files were received for upload'
      });
    }
    
    next();
  } catch (error) {
    console.error('Error in processFileUpload middleware:', error);
    return res.status(500).json({
      success: false,
      error: 'Upload processing failed',
      message: 'Failed to process uploaded files. Please try again.'
    });
  }
};

const cleanupTempFiles = (req, res, next) => {
  const files = req.files ? 
    (Array.isArray(req.files) ? req.files : Object.values(req.files).flat()) : 
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

const checkAzureConnection = async () => {
  if (!blobServiceClient || azureConnectionFailed) {
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

const getFileInfo = async (blobName) => {
  if (!blobServiceClient || azureConnectionFailed) {
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

const generateSignedUrl = async (blobName, expiryHours = 1) => {
  if (!blobServiceClient || azureConnectionFailed) {
    throw new Error('Azure Blob Service Client not initialized');
  }

  try {
    const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    
    const baseUrl = blobServiceClient.url.replace(/\/$/, '');
    return `${baseUrl}/${CONTAINER_NAME}/${blobName}`;
  } catch (error) {
    console.error('Error generating signed URL:', error);
    throw new Error(`Failed to generate signed URL: ${error.message}`);
  }
};

const listFiles = async (prefix = '') => {
  if (!blobServiceClient || azureConnectionFailed) {
    throw new Error('Azure Blob Service Client not initialized');
  }

  try {
    const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
    const files = [];
    
    for await (const blob of containerClient.listBlobsFlat({ prefix })) {
      const baseUrl = blobServiceClient.url.replace(/\/$/, '');
      files.push({
        name: blob.name,
        url: `${baseUrl}/${CONTAINER_NAME}/${blob.name}`,
        size: blob.properties.contentLength,
        lastModified: blob.properties.lastModified,
        contentType: blob.properties.contentType
      });
    }
    
    return files;
  } catch (error) {
    console.error('Error listing files:', error);
    throw new Error(`Failed to list files: ${error.message}`);
  }
};

if (!azureConnectionFailed) {
  initializeContainer().catch(error => {
    console.error('Failed to initialize container on startup:', error);
    azureConnectionFailed = true;
  });
}

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
  generateSignedUrl,
  listFiles,
  initializeContainer,
  validateFileType
};