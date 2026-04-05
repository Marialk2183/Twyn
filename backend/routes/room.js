const express = require('express');
const router = express.Router();
const { createRoom, getRoom, getRoomMessages } = require('../controllers/roomController');

// Middleware: validate room ID format
const validateRoomId = (req, res, next) => {
  const { roomId } = req.params;
  if (!/^[A-Z0-9]{6}$/.test(roomId)) {
    return res.status(400).json({ error: 'Invalid room ID format' });
  }
  next();
};

router.post('/create', createRoom);
router.get('/:roomId', validateRoomId, getRoom);
router.get('/:roomId/messages', validateRoomId, getRoomMessages);

module.exports = router;
