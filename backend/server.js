require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const roomRoutes = require('./routes/room');
const chatSocket = require('./sockets/chatSocket');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || '*',
    methods: ['GET', 'POST']
  },
  pingTimeout: 60000
});

// ── Security middleware ──────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'cdn.socket.io'],
      styleSrc: ["'self'", "'unsafe-inline'", 'fonts.googleapis.com'],
      fontSrc: ["'self'", 'fonts.gstatic.com'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      imgSrc: ["'self'", 'data:']
    }
  }
}));

app.use(cors({ origin: process.env.CLIENT_URL || '*' }));
app.use(express.json({ limit: '20kb' }));

// Rate limiting on API routes only
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

const createRoomLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  message: { error: 'Too many rooms created from this IP.' }
});

app.use('/api', apiLimiter);
app.use('/api/rooms/create', createRoomLimiter);

// ── Static frontend ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../frontend'), {
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
}));

// ── REST API routes ──────────────────────────────────────────────────────────
app.use('/api/rooms', roomRoutes);

// Serve room page for any /room/:id URL (client-side handles validation)
app.get('/room/:roomId', (req, res) => {
  const { roomId } = req.params;
  // Validate room ID format before serving
  if (!/^[A-Z0-9]{6}$/.test(roomId)) {
    return res.status(400).sendFile(path.join(__dirname, '../frontend/404.html'));
  }
  res.sendFile(path.join(__dirname, '../frontend/room.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Suppress favicon 404
app.get('/favicon.ico', (req, res) => res.status(204).end());

// 404 fallback
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, '../frontend/404.html'));
});

// ── Socket.IO ────────────────────────────────────────────────────────────────
chatSocket(io);

// ── MongoDB ──────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/mf_chatt';

async function connectDB() {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
      console.log('[DB] MongoDB connected');
      return;
    } catch (err) {
      console.error(`[DB] Connection attempt ${attempt}/5 failed: ${err.message}`);
      if (attempt < 5) {
        console.log('[DB] Retrying in 3 seconds…');
        await new Promise(r => setTimeout(r, 3000));
      } else {
        console.error('[DB] Could not connect to MongoDB. Is mongod running on port 27017?');
        process.exit(1);
      }
    }
  }
}

connectDB();

mongoose.connection.on('disconnected', () => {
  console.warn('[DB] MongoDB disconnected');
});

// ── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);
  console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  server.close(() => {
    mongoose.connection.close(false, () => process.exit(0));
  });
});
