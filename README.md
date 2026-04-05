# LockChat — Secure 1-to-1 Private Chat

A real-time, end-to-end encrypted private chat application. Two users share a unique 6-character room link. The server **never sees your messages** — only ciphertext.

---

## Architecture

```
MF_APP_CHATT/
├── backend/
│   ├── server.js                  # Express + Socket.IO entry point
│   ├── routes/room.js             # REST: create/get room, get messages
│   ├── controllers/roomController.js
│   ├── models/
│   │   ├── Room.js                # Room schema (TTL: 24h auto-delete)
│   │   └── Message.js             # Message schema (stores ONLY ciphertext)
│   ├── sockets/chatSocket.js      # All real-time logic
│   ├── .env                       # Environment variables
│   └── package.json
└── frontend/
    ├── index.html                 # Landing page (create / join room)
    ├── room.html                  # Chat interface
    ├── 404.html
    ├── css/style.css              # WhatsApp-style dark theme
    └── js/
        ├── crypto.js              # ECDH + AES-GCM encryption (Web Crypto API)
        ├── app.js                 # Landing page logic
        └── chat.js                # Room chat logic
```

---

## How to Run Locally

### Prerequisites
- Node.js 18+
- MongoDB running locally (`mongod`) or a MongoDB Atlas URI

### Steps

```bash
# 1. Navigate to backend
cd MF_APP_CHATT/backend

# 2. Install dependencies
npm install

# 3. Configure environment (already set for local dev)
#    Edit .env if you need a different MongoDB URI or port

# 4. Start the server
npm run dev        # development (auto-reload with nodemon)
# or
npm start          # production

# 5. Open browser
#    http://localhost:3000
```

---

## How to Use

1. **User A** opens `http://localhost:3000` → clicks **Create Private Room**
2. A unique link like `http://localhost:3000/room/ABX92K` is generated
3. **User A** copies and shares the link with **User B**
4. **User B** opens the link → both users are connected
5. The app establishes an encrypted channel (ECDH key exchange)
6. Both users can send and receive messages in real-time

---

## Encryption Workflow

```
User A                         Server                        User B
  │                               │                              │
  │── Generate ECDH key pair ──►  │                              │
  │── Send public key (JWK) ────► │ ──► relay ──────────────►   │
  │                               │                              │── Generate ECDH key pair
  │                               │                              │── Send public key (JWK)
  │◄──────────────── relay ◄──── │ ◄── public key ─────────────│
  │                               │                              │
  │── deriveSharedKey(B.pubKey)  │          deriveSharedKey(A.pubKey) ──│
  │   → AES-256-GCM key          │                 → same AES-256-GCM key
  │                               │                              │
  │── encrypt("hello") ─────────►│ stores: {encryptedContent, iv}
  │                               │─────────────────────────────►│
  │                               │                              │── decrypt(ciphertext, iv)
  │                               │                              │   → "hello"
```

**Key points:**
- Uses the **Web Crypto API** (native browser, no third-party libraries)
- ECDH with **P-256** curve — ephemeral keys, new pair on every page load
- Provides **Perfect Forward Secrecy** — compromising one session doesn't affect others
- **AES-GCM-256** for authenticated encryption (also detects tampering)
- The private key is marked `extractable: false` — it **cannot** be exported or stolen
- Server stores only base64(ciphertext) + base64(12-byte IV)
- Messages and rooms are **auto-deleted after 24 hours** via MongoDB TTL indexes

---

## Security Features

| Feature | Implementation |
|---------|---------------|
| E2E Encryption | ECDH key exchange + AES-256-GCM |
| Max 2 users | Enforced server-side via Socket.IO + MongoDB |
| Input validation | Regex + length checks on all server inputs |
| XSS prevention | `textContent` only (never `innerHTML`) for messages |
| Rate limiting | express-rate-limit on all API routes |
| HTTP security headers | Helmet.js with CSP |
| Auto-delete | MongoDB TTL indexes (24h for rooms + messages) |
| Room auto-delete | When both users leave, room + messages deleted immediately |
| Reconnect support | `clientId` in sessionStorage allows refresh without losing slot |

---

## Deploying to Production

### Option 1: Render.com (Free tier)

1. Push code to GitHub
2. Create a **Web Service** on Render → connect repo
3. Set **Root Directory**: `backend`
4. Set **Build Command**: `npm install`
5. Set **Start Command**: `npm start`
6. Add **Environment Variables**:
   ```
   MONGODB_URI=<your-atlas-uri>
   CLIENT_URL=https://your-app.onrender.com
   NODE_ENV=production
   ```

### Option 2: Railway

```bash
# Install Railway CLI
npm install -g @railway/cli

railway login
railway init
railway up
```

Add env vars in the Railway dashboard.

### MongoDB Atlas (Cloud DB)

1. Create free cluster at mongodb.com/atlas
2. Whitelist `0.0.0.0/0` for hosting platforms
3. Copy the connection string → paste as `MONGODB_URI`

---

## Optional / Bonus Features Included

- **Typing indicator** — debounced, shows "Other is typing…"
- **Auto-scroll** — scrolls to latest message automatically
- **Copy link button** — one-click share
- **Auto-delete room** — immediately when both users disconnect
- **Reconnect support** — refresh doesn't lose your chat slot
- **Message history** — previous messages loaded and decrypted on join
- **Online/offline status** — status bar shows peer connection state
