const express = require('express');
const {
  getEvents,
  getEventById,
  registerForEvent,
  getRegisteredEvents,
  verifyAttendance,
  getEventAttendees
} = require('../controllers/event.controller');
const { protect, authorize } = require('../middleware/auth.middleware');

const router = express.Router();

router.get('/', getEvents);
router.get('/registered', protect, getRegisteredEvents);
router.get('/:id', getEventById);
router.post('/:id/register', protect, registerForEvent);
router.post('/:id/verify-attendance', protect, authorize('coordinator', 'admin'), verifyAttendance);
router.get('/:id/attendees', protect, authorize('coordinator', 'admin'), getEventAttendees);

module.exports = router;
