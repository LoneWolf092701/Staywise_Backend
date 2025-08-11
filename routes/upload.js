const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const {
  upload,
  uploadProfileImage,
  uploadPropertyImages,
  processFileUpload,
  handleUploadError,
  deleteFromAzure,
  checkAzureConnection
} = require('../middleware/upload');

/**
 * GET /api/upload/test
 * Test route to check if upload system is working
 */
router.get('/test', async (req, res) => {
  try {
    const azureStatus = await checkAzureConnection();
    res.json({
      message: 'Upload system test',
      azure_status: azureStatus,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Test failed',
      message: error.message
    });
  }
});

/**
 * POST /api/upload/single
 * Upload single image
 */
router.post('/single', auth, uploadProfileImage, processFileUpload, (req, res) => {
  try {
    console.log('Upload route - req.uploadedFile:', req.uploadedFile);
    console.log('Upload route - req.file:', req.file);
    
    if (!req.uploadedFile) {
      console.error('No uploadedFile in request');
      return res.status(400).json({
        success: false,
        error: 'No file uploaded',
        message: 'Please select a file to upload'
      });
    }

    res.json({
      uploadedFile: {
        url: req.uploadedFile.url,
        filename: req.uploadedFile.filename,
        originalname: req.uploadedFile.originalname,
        size: req.uploadedFile.size,
        mimetype: req.uploadedFile.mimetype
      }
    });
  } catch (error) {
    console.error('Single upload error:', error);
    res.status(500).json({
      success: false,
      error: 'Upload failed',
      message: error.message || 'Failed to process upload'
    });
  }
});

/**
 * POST /api/upload/multiple
 * Upload multiple images
 */
router.post('/multiple', auth, uploadPropertyImages, processFileUpload, (req, res) => {
  try {
    if (!req.uploadedFiles || !req.uploadedFiles.files || req.uploadedFiles.files.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No files uploaded',
        message: 'Please select files to upload'
      });
    }

    const uploadedFiles = req.uploadedFiles.files.map(file => ({
      url: file.url,
      filename: file.filename,
      originalname: file.originalname,
      size: file.size,
      mimetype: file.mimetype
    }));

    res.json({
      uploadedFiles: {
        propertyImages: uploadedFiles
      }
    });
  } catch (error) {
    console.error('Multiple upload error:', error);
    res.status(500).json({
      success: false,
      error: 'Upload failed',
      message: 'Failed to process upload'
    });
  }
});

/**
 * POST /api/upload/mixed
 * Upload mixed files (profile images, property images, documents)
 */
router.post('/mixed', auth, upload.fields([
  { name: 'profileImage', maxCount: 1 },
  { name: 'propertyImages', maxCount: 10 },
  { name: 'documents', maxCount: 5 }
]), processFileUpload, (req, res) => {
  try {
    if (!req.uploadedFiles) {
      return res.status(400).json({
        success: false,
        error: 'No files uploaded',
        message: 'Please select files to upload'
      });
    }

    const responseFiles = {};
    
    Object.keys(req.uploadedFiles).forEach(fieldName => {
      responseFiles[fieldName] = req.uploadedFiles[fieldName].map(file => ({
        url: file.url,
        filename: file.filename,
        originalname: file.originalname,
        size: file.size,
        mimetype: file.mimetype
      }));
    });

    res.json({
      uploadedFiles: responseFiles
    });
  } catch (error) {
    console.error('Mixed upload error:', error);
    res.status(500).json({
      success: false,
      error: 'Upload failed',
      message: 'Failed to process mixed upload'
    });
  }
});

/**
 * DELETE /api/upload/file
 * Delete uploaded file
 */
router.delete('/file', auth, async (req, res) => {
  try {
    const { file_url } = req.body;

    if (!file_url) {
      return res.status(400).json({
        success: false,
        error: 'Missing file URL',
        message: 'File URL is required for deletion'
      });
    }

    const urlParts = file_url.split('/');
    const fileName = urlParts[urlParts.length - 1];

    const deleted = await deleteFromAzure(fileName);

    if (deleted) {
      res.json({
        success: true,
        message: 'File deleted successfully',
        file_url: file_url
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'File not found',
        message: 'File could not be found or was already deleted'
      });
    }
  } catch (error) {
    console.error('Delete file error:', error);
    res.status(500).json({
      success: false,
      error: 'Deletion failed',
      message: 'Failed to delete file'
    });
  }
});

/**
 * GET /api/upload/progress/:uploadId
 * Get upload progress (placeholder for future implementation)
 */
router.get('/progress/:uploadId', auth, (req, res) => {
  try {
    const { uploadId } = req.params;
    
    res.json({
      upload_id: uploadId,
      status: 'completed',
      progress: 100,
      total_files: 1,
      completed_files: 1
    });
  } catch (error) {
    console.error('Get upload progress error:', error);
    res.status(500).json({
      upload_id: req.params.uploadId,
      status: 'error',
      progress: 0,
      total_files: 0,
      completed_files: 0,
      error: error.message
    });
  }
});

/**
 * POST /api/upload/cancel/:uploadId
 * Cancel upload (placeholder for future implementation)
 */
router.post('/cancel/:uploadId', auth, (req, res) => {
  try {
    const { uploadId } = req.params;
    
    res.json({
      upload_id: uploadId,
      status: 'cancelled',
      message: 'Upload cancelled successfully'
    });
  } catch (error) {
    console.error('Cancel upload error:', error);
    res.status(500).json({
      success: false,
      error: 'Cancellation failed',
      message: 'Failed to cancel upload'
    });
  }
});

router.use(handleUploadError);

module.exports = router;