const express = require('express');
const { 
    adminLogin, 
    getAllUsers, 
    verifyUser, 
    getStats, 
    updateUserStatus, 
    getRegistrationStats,
    getConnections,
    approveConnection,
    rejectConnection,
    getAnnouncements,
    createAnnouncement,
    updateAnnouncement,
    deleteAnnouncement,
    uploadAnnouncementImage
} = require('../controllers/adminController');
const { protect, authorize } = require('../middleware/authMiddleware');
const upload = require('../config/cloudinary');

const router = express.Router();

// Public login
router.post('/login', adminLogin);

router.get('/registration-stats', getRegistrationStats);

// Protected admin-only routes
router.use(protect);
router.use(authorize('Admin'));

router.get('/users', getAllUsers);
router.get('/stats', getStats);
router.put('/users/:id/verify', verifyUser);
router.put('/users/:id/status', updateUserStatus);
router.get('/connections', getConnections);
router.put('/connections/:id/approve', approveConnection);
router.put('/connections/:id/reject', rejectConnection);

// Announcements
router.get('/announcements', getAnnouncements);
router.post('/announcements', createAnnouncement);
router.put('/announcements/:id', updateAnnouncement);
router.delete('/announcements/:id', deleteAnnouncement);
router.post('/announcements/upload', upload.single('image'), uploadAnnouncementImage);

module.exports = router;
