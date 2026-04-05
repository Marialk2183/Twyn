const Room = require('../models/Room');
const Message = require('../models/Message');

// Generates a random 6-char alphanumeric room ID (uppercase)
function generateRoomId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  // Use crypto.getRandomValues equivalent in Node
  const { randomInt } = require('crypto');
  for (let i = 0; i < 6; i++) {
    id += chars[randomInt(0, chars.length)];
  }
  return id;
}

// POST /api/rooms/create
const createRoom = async (req, res) => {
  try {
    let roomId;
    let attempts = 0;

    // Retry on collision (extremely rare)
    do {
      roomId = generateRoomId();
      attempts++;
      if (attempts > 10) {
        return res.status(500).json({ error: 'Could not generate unique room ID' });
      }
    } while (await Room.findOne({ roomId }));

    const room = new Room({ roomId, users: [], isLocked: false });
    await room.save();

    res.status(201).json({ success: true, roomId });
  } catch (err) {
    console.error('[createRoom]', err.message);
    res.status(500).json({ error: 'Failed to create room' });
  }
};

// GET /api/rooms/:roomId
const getRoom = async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }
    res.json({
      success: true,
      roomId: room.roomId,
      userCount: room.users.length,
      isLocked: room.isLocked
    });
  } catch (err) {
    console.error('[getRoom]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
};

// GET /api/rooms/:roomId/messages
const getRoomMessages = async (req, res) => {
  try {
    // Verify room exists
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    const messages = await Message.find(
      { roomId: req.params.roomId },
      { encryptedContent: 1, iv: 1, senderIndex: 1, timestamp: 1 }
    )
      .sort({ timestamp: 1 })
      .limit(500)
      .lean();

    res.json({ success: true, messages });
  } catch (err) {
    console.error('[getRoomMessages]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports = { createRoom, getRoom, getRoomMessages };
