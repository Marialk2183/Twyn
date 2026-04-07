const Room = require('../models/Room');
const Message = require('../models/Message');

// Basic validation helpers (server never inspects plaintext content)
const isValidRoomId = (id) => typeof id === 'string' && /^[A-Z0-9]{6}$/.test(id);
const isValidClientId = (id) => typeof id === 'string' && id.length >= 8 && id.length <= 64;
const isValidBase64 = (str, maxLen = 250000) =>
  typeof str === 'string' && str.length > 0 && str.length <= maxLen && /^[A-Za-z0-9+/=]+$/.test(str);

module.exports = (io) => {
  io.on('connection', (socket) => {
    console.log(`[Socket] Connected: ${socket.id}`);

    // ── Join Room ────────────────────────────────────────────────────────────
    socket.on('join-room', async ({ roomId, clientId }) => {
      if (!isValidRoomId(roomId) || !isValidClientId(clientId)) {
        socket.emit('join-error', { message: 'Invalid room or client ID.' });
        return;
      }

      try {
        let room = await Room.findOne({ roomId });

        if (!room) {
          socket.emit('join-error', { message: 'Room not found. It may have expired.' });
          return;
        }

        // Check if this clientId is already in the room (reconnect scenario)
        const existingSlot = room.users.find(u => u.clientId === clientId);

        if (existingSlot) {
          // Reconnect: update socketId for this client
          existingSlot.socketId = socket.id;
          await room.save();

          socket.join(roomId);
          socket.roomId = roomId;
          socket.clientId = clientId;
          socket.slotIndex = existingSlot.slotIndex;

          socket.emit('joined', {
            slotIndex: existingSlot.slotIndex,
            userCount: room.users.length,
            reconnected: true
          });

          // Notify peer
          socket.to(roomId).emit('peer-reconnected', { userCount: room.users.length });

          // Send message history
          const messages = await Message.find(
            { roomId },
            { encryptedContent: 1, iv: 1, senderIndex: 1, messageType: 1, mimeType: 1, timestamp: 1 }
          ).sort({ timestamp: 1 }).limit(500).lean();

          socket.emit('message-history', messages);
          return;
        }

        // New user joining
        if (room.isLocked || room.users.length >= 2) {
          socket.emit('join-error', { message: 'Room is full. Only 2 users allowed per room.' });
          return;
        }

        const slotIndex = room.users.length; // 0 for first, 1 for second

        room.users.push({ socketId: socket.id, clientId, slotIndex });
        if (room.users.length >= 2) room.isLocked = true;
        await room.save();

        socket.join(roomId);
        socket.roomId = roomId;
        socket.clientId = clientId;
        socket.slotIndex = slotIndex;

        socket.emit('joined', {
          slotIndex,
          userCount: room.users.length,
          reconnected: false
        });

        // Notify existing peer that someone new joined
        socket.to(roomId).emit('peer-joined', { userCount: room.users.length });

        // Send message history to new joiner
        const messages = await Message.find(
          { roomId },
          { encryptedContent: 1, iv: 1, senderIndex: 1, messageType: 1, mimeType: 1, timestamp: 1 }
        ).sort({ timestamp: 1 }).limit(500).lean();

        socket.emit('message-history', messages);
      } catch (err) {
        console.error('[join-room]', err.message);
        socket.emit('join-error', { message: 'Server error while joining room.' });
      }
    });

    // ── Key Exchange (ECDH public key relay) ─────────────────────────────────
    // Server only relays JWK public key — cannot decrypt anything with it alone
    socket.on('public-key', ({ roomId, publicKey }) => {
      if (!isValidRoomId(roomId) || typeof publicKey !== 'string' || publicKey.length > 2048) return;
      // Relay to the OTHER user in the room only
      socket.to(roomId).emit('peer-public-key', { publicKey });
    });

    // ── Send Encrypted Message ───────────────────────────────────────────────
    socket.on('send-message', async ({ roomId, encryptedContent, iv, messageType, mimeType }) => {
      if (!isValidRoomId(roomId)) return;
      if (!isValidBase64(encryptedContent)) return;
      if (!isValidBase64(iv, 64)) return;
      if (socket.roomId !== roomId) return; // Must be in this room

      const type = messageType === 'audio' ? 'audio' : 'text';
      const mime = type === 'audio' && typeof mimeType === 'string' ? mimeType.slice(0, 64) : null;

      try {
        const message = new Message({
          roomId,
          encryptedContent,
          iv,
          senderIndex: socket.slotIndex,
          messageType: type,
          mimeType: mime,
          timestamp: new Date()
        });
        await message.save();

        // Broadcast to ALL users in room (sender gets confirmation, receiver gets message)
        io.to(roomId).emit('new-message', {
          _id: message._id.toString(),
          encryptedContent,
          iv,
          senderIndex: socket.slotIndex,
          messageType: type,
          mimeType: mime,
          timestamp: message.timestamp
        });
      } catch (err) {
        console.error('[send-message]', err.message);
      }
    });

    // ── Typing Indicator ─────────────────────────────────────────────────────
    socket.on('typing', ({ roomId, isTyping }) => {
      if (!isValidRoomId(roomId) || socket.roomId !== roomId) return;
      socket.to(roomId).emit('peer-typing', { isTyping: Boolean(isTyping) });
    });

    // ── Message Reaction (relay only — not stored) ────────────────────────────
    socket.on('message-reaction', ({ roomId, messageId, emoji }) => {
      if (!isValidRoomId(roomId) || socket.roomId !== roomId) return;
      if (typeof messageId !== 'string' || messageId.length > 64) return;
      const VALID = ['👍','❤️','😂','😮','😢','🔥'];
      if (!VALID.includes(emoji)) return;
      socket.to(roomId).emit('message-reaction', { messageId, emoji });
    });

    // ── Seen Receipt ──────────────────────────────────────────────────────────
    socket.on('message-seen', ({ roomId, messageId }) => {
      if (!isValidRoomId(roomId) || socket.roomId !== roomId) return;
      if (typeof messageId !== 'string' || messageId.length > 64) return;
      socket.to(roomId).emit('message-seen', { messageId });
    });

    // ── WebRTC Signaling ──────────────────────────────────────────────────────
    socket.on('call-offer', ({ roomId, offer, callType }) => {
      if (!isValidRoomId(roomId) || socket.roomId !== roomId) return;
      if (!['audio', 'video'].includes(callType)) return;
      if (!offer || typeof offer !== 'object') return;
      socket.to(roomId).emit('call-offer', { offer, callType });
    });

    socket.on('call-answer', ({ roomId, answer }) => {
      if (!isValidRoomId(roomId) || socket.roomId !== roomId) return;
      if (!answer || typeof answer !== 'object') return;
      socket.to(roomId).emit('call-answer', { answer });
    });

    socket.on('ice-candidate', ({ roomId, candidate }) => {
      if (!isValidRoomId(roomId) || socket.roomId !== roomId) return;
      if (!candidate || typeof candidate !== 'object') return;
      socket.to(roomId).emit('ice-candidate', { candidate });
    });

    socket.on('call-end', ({ roomId }) => {
      if (!isValidRoomId(roomId) || socket.roomId !== roomId) return;
      socket.to(roomId).emit('call-end');
    });

    socket.on('call-rejected', ({ roomId }) => {
      if (!isValidRoomId(roomId) || socket.roomId !== roomId) return;
      socket.to(roomId).emit('call-rejected');
    });

    // ── Disconnect ───────────────────────────────────────────────────────────
    socket.on('disconnect', async (reason) => {
      console.log(`[Socket] Disconnected: ${socket.id} (${reason})`);

      if (!socket.roomId) return;

      try {
        const room = await Room.findOne({ roomId: socket.roomId });
        if (!room) return;

        // Remove this socket from users list
        room.users = room.users.filter(u => u.socketId !== socket.id);

        if (room.users.length === 0) {
          // Auto-delete room and all messages when both users leave
          await Room.deleteOne({ roomId: socket.roomId });
          await Message.deleteMany({ roomId: socket.roomId });
          console.log(`[Room] Auto-deleted: ${socket.roomId}`);
        } else {
          // One user left — unlock room so the remaining user can invite someone new
          room.isLocked = false;
          await room.save();
          io.to(socket.roomId).emit('peer-disconnected', {
            userCount: room.users.length,
            lastSeen: new Date().toISOString()
          });
        }
      } catch (err) {
        console.error('[disconnect]', err.message);
      }
    });
  });
};
