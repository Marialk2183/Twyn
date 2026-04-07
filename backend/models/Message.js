const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  roomId: {
    type: String,
    required: true,
    index: true,
    match: /^[A-Z0-9]{6}$/
  },
  // Server only ever stores ciphertext — never plaintext
  encryptedContent: {
    type: String,
    required: true,
    maxlength: 250000 // text: ~15KB | audio: up to ~180KB (60s voice at Opus quality)
  },
  iv: {
    type: String,
    required: true,
    maxlength: 64
  },
  senderIndex: {
    type: Number,
    required: true,
    enum: [0, 1]
  },
  messageType: {
    type: String,
    enum: ['text', 'audio'],
    default: 'text'
  },
  mimeType: {
    type: String,
    maxlength: 64,
    default: null
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
});

// Auto-delete messages after 24 hours
messageSchema.index({ timestamp: 1 }, { expireAfterSeconds: 86400 });

module.exports = mongoose.model('Message', messageSchema);
