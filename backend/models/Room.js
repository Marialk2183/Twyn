const mongoose = require('mongoose');

const userSlotSchema = new mongoose.Schema({
  socketId: { type: String, required: true },
  clientId: { type: String, required: true }, // Persistent browser identity
  slotIndex: { type: Number, required: true } // 0 or 1
}, { _id: false });

const roomSchema = new mongoose.Schema({
  roomId: {
    type: String,
    required: true,
    unique: true,
    index: true,
    match: /^[A-Z0-9]{6}$/
  },
  users: [userSlotSchema],
  isLocked: { type: Boolean, default: false },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 86400 // TTL: auto-delete room document after 24 hours
  }
});

roomSchema.virtual('userCount').get(function () {
  return this.users.length;
});

module.exports = mongoose.model('Room', roomSchema);
