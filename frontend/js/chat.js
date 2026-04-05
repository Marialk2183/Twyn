/**
 * chat.js — Room chat page logic
 *
 * Flow:
 *  1. Extract roomId from URL
 *  2. Generate or retrieve persistent clientId from sessionStorage
 *  3. Connect Socket.IO → join room
 *  4. Generate ECDH key pair → broadcast public key
 *  5. On receiving peer's public key → derive shared AES-GCM key
 *  6. Enable chat (input + history decryption)
 *  7. On send: encrypt → emit to server → server stores + relays ciphertext
 *  8. On receive: decrypt → render bubble
 */

(async function () {
  // ── Constants & State ──────────────────────────────────────────────────────
  const TYPING_DEBOUNCE_MS = 1500;

  const roomId = getRoomIdFromUrl();
  if (!roomId) return redirectHome('Invalid room URL.');

  // Persistent identity per browser session (survives refresh, not new tab)
  const clientId = getOrCreateClientId();

  let mySlotIndex = null;       // 0 or 1 — assigned by server
  let chatEnabled = false;      // true after key exchange complete
  let pendingHistory = null;    // message history awaiting key exchange
  let myPublicKeySent = false;  // prevent duplicate key broadcasts
  let sharedKeyDerived = false; // prevent duplicate derivations
  let typingTimer = null;
  let isTyping = false;

  // ── DOM References ─────────────────────────────────────────────────────────
  const messagesEl      = document.getElementById('messages');
  const inputEl         = document.getElementById('message-input');
  const sendBtn         = document.getElementById('send-btn');
  const statusBar       = document.getElementById('status-bar');
  const typingEl        = document.getElementById('typing-indicator');
  const encryptBadge    = document.getElementById('encrypt-badge');
  const roomIdDisplay   = document.getElementById('room-id-display');
  const copyLinkBtn     = document.getElementById('copy-link-btn');
  const waitingOverlay  = document.getElementById('waiting-overlay');
  const waitingMsg      = document.getElementById('waiting-msg');
  const errorOverlay    = document.getElementById('error-overlay');
  const errorMsg        = document.getElementById('error-msg');

  roomIdDisplay.textContent = roomId;

  // ── Validate room exists before connecting socket ─────────────────────────
  try {
    const res = await fetch(`/api/rooms/${roomId}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showError(data.error || 'Room not found or has expired.');
      return;
    }
  } catch {
    showError('Cannot reach server. Check your connection.');
    return;
  }

  // ── Socket.IO Connection ───────────────────────────────────────────────────
  const socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    console.log('[Socket] Connected:', socket.id);
    setStatus('Joining room…', 'connecting');
    socket.emit('join-room', { roomId, clientId });
  });

  socket.on('connect_error', () => {
    setStatus('Connection lost. Reconnecting…', 'error');
  });

  socket.on('disconnect', () => {
    setStatus('Disconnected from server.', 'error');
    setChatEnabled(false);
  });

  // ── Room Events ────────────────────────────────────────────────────────────
  socket.on('joined', async ({ slotIndex, userCount, reconnected }) => {
    mySlotIndex = slotIndex;
    console.log(`[Room] Joined as slot ${slotIndex}, users: ${userCount}, reconnected: ${reconnected}`);

    // Generate ECDH key pair
    await CryptoHelper.generateKeyPair();

    if (userCount >= 2) {
      // Peer already present — send our public key to trigger key exchange
      broadcastPublicKey();
      setStatus('Peer present. Establishing secure channel…', 'connecting');
    } else {
      // We're first — wait for peer
      showWaiting();
      setStatus('Waiting for peer to join…', 'waiting');
    }
  });

  socket.on('peer-joined', () => {
    console.log('[Room] Peer joined');
    hideWaiting();
    setStatus('Peer joined. Establishing secure channel…', 'connecting');
    // Broadcast our key so the new peer can derive the shared key
    broadcastPublicKey();
  });

  socket.on('peer-reconnected', () => {
    console.log('[Room] Peer reconnected');
    // Re-exchange keys (peer generated a new key pair on reconnect)
    sharedKeyDerived = false;
    myPublicKeySent = false;
    broadcastPublicKey();
    setStatus('Peer reconnected. Re-establishing secure channel…', 'connecting');
  });

  socket.on('peer-disconnected', ({ userCount }) => {
    console.log('[Room] Peer disconnected');
    setChatEnabled(false);
    sharedKeyDerived = false;
    myPublicKeySent = false;
    showWaiting('Peer disconnected. Waiting for them to reconnect…');
    setStatus('Peer disconnected.', 'waiting');
    typingEl.style.display = 'none';
  });

  socket.on('join-error', ({ message }) => {
    showError(message);
  });

  // ── Key Exchange ───────────────────────────────────────────────────────────
  socket.on('peer-public-key', async ({ publicKey }) => {
    if (sharedKeyDerived) {
      // Peer reconnected with a new key — re-derive
      console.log('[Crypto] Re-deriving shared key for reconnected peer');
      sharedKeyDerived = false;
    }

    try {
      await CryptoHelper.deriveSharedKey(publicKey);
      sharedKeyDerived = true;
      console.log('[Crypto] Shared AES-256-GCM key derived successfully');

      // Send our public key so peer can derive theirs (idempotent — they ignore duplicates)
      broadcastPublicKey();

      // Unlock chat UI
      setChatEnabled(true);
      setStatus('End-to-end encrypted', 'secure');
      encryptBadge.style.display = 'inline-flex';
      hideWaiting();

      // Decrypt and display pending history
      if (pendingHistory) {
        await renderHistory(pendingHistory);
        pendingHistory = null;
      }
    } catch (err) {
      console.error('[Crypto] Key derivation failed:', err);
      setStatus('Encryption setup failed. Refresh to retry.', 'error');
    }
  });

  function broadcastPublicKey() {
    if (myPublicKeySent) return;
    myPublicKeySent = true;
    socket.emit('public-key', { roomId, publicKey: CryptoHelper.getMyPublicKey() });
  }

  // ── Message History ────────────────────────────────────────────────────────
  socket.on('message-history', async (messages) => {
    if (!messages || messages.length === 0) return;

    if (chatEnabled) {
      await renderHistory(messages);
    } else {
      pendingHistory = messages; // Will be rendered after key exchange
    }
  });

  async function renderHistory(messages) {
    for (const msg of messages) {
      await renderMessage(msg, true);
    }
    scrollToBottom();
  }

  // ── Incoming Messages ──────────────────────────────────────────────────────
  socket.on('new-message', async (msg) => {
    if (!chatEnabled) return;
    await renderMessage(msg, false);
    scrollToBottom();
  });

  async function renderMessage(msg, isHistory) {
    const isMine = msg.senderIndex === mySlotIndex;
    let text = '';

    try {
      text = await CryptoHelper.decrypt(msg.encryptedContent, msg.iv);
    } catch {
      text = '[Could not decrypt message]';
    }

    // Sanitize for XSS — ONLY use textContent, never innerHTML for user content
    const bubble = document.createElement('div');
    bubble.className = `message-wrapper ${isMine ? 'mine' : 'theirs'}`;

    const label = document.createElement('span');
    label.className = 'message-label';
    label.textContent = isMine ? 'You' : 'Other';

    const content = document.createElement('div');
    content.className = 'message-bubble';
    content.textContent = text; // Safe — no innerHTML

    const time = document.createElement('span');
    time.className = 'message-time';
    time.textContent = formatTime(msg.timestamp);

    bubble.appendChild(label);
    bubble.appendChild(content);
    bubble.appendChild(time);
    messagesEl.appendChild(bubble);

    if (!isHistory) {
      bubble.classList.add('message-new');
    }
  }

  // ── Send Message ───────────────────────────────────────────────────────────
  async function sendMessage() {
    if (!chatEnabled) return;
    const text = inputEl.value.trim();
    if (!text) return;

    inputEl.value = '';
    stopTypingIndicator();

    try {
      const { encryptedContent, iv } = await CryptoHelper.encrypt(text);
      socket.emit('send-message', { roomId, encryptedContent, iv });
    } catch (err) {
      console.error('[Send] Encryption failed:', err);
      showToast('Failed to encrypt message. Please try again.');
    }
  }

  sendBtn.addEventListener('click', sendMessage);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // ── Typing Indicator ───────────────────────────────────────────────────────
  inputEl.addEventListener('input', () => {
    if (!chatEnabled) return;
    if (!isTyping) {
      isTyping = true;
      socket.emit('typing', { roomId, isTyping: true });
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(stopTypingIndicator, TYPING_DEBOUNCE_MS);
  });

  function stopTypingIndicator() {
    if (isTyping) {
      isTyping = false;
      socket.emit('typing', { roomId, isTyping: false });
    }
    clearTimeout(typingTimer);
  }

  socket.on('peer-typing', ({ isTyping: peerTyping }) => {
    typingEl.style.display = peerTyping ? 'flex' : 'none';
    if (peerTyping) scrollToBottom();
  });

  // ── Copy Room Link ─────────────────────────────────────────────────────────
  copyLinkBtn.addEventListener('click', async () => {
    const link = `${window.location.origin}/room/${roomId}`;
    try {
      await navigator.clipboard.writeText(link);
      copyLinkBtn.textContent = 'Copied!';
      setTimeout(() => (copyLinkBtn.textContent = 'Copy Link'), 2000);
    } catch {
      // Fallback for browsers without clipboard API
      prompt('Copy this link and share it:', link);
    }
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  function setChatEnabled(enabled) {
    chatEnabled = enabled;
    inputEl.disabled = !enabled;
    sendBtn.disabled = !enabled;
    if (enabled) inputEl.focus();
  }

  function setStatus(text, type) {
    statusBar.textContent = text;
    statusBar.className = `status-bar status-${type}`;
  }

  function showWaiting(msg = 'Waiting for other person to join…\nShare the link below!') {
    waitingOverlay.style.display = 'flex';
    waitingMsg.textContent = msg;
  }

  function hideWaiting() {
    waitingOverlay.style.display = 'none';
  }

  function showError(msg) {
    errorOverlay.style.display = 'flex';
    errorMsg.textContent = msg;
  }

  function showToast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function formatTime(ts) {
    const d = ts ? new Date(ts) : new Date();
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function getRoomIdFromUrl() {
    const match = window.location.pathname.match(/\/room\/([A-Za-z0-9]{6})$/);
    return match ? match[1].toUpperCase() : null;
  }

  function getOrCreateClientId() {
    let id = sessionStorage.getItem('mfchatt_clientId');
    if (!id) {
      // Generate a random 32-char hex ID
      const arr = new Uint8Array(16);
      window.crypto.getRandomValues(arr);
      id = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
      sessionStorage.setItem('mfchatt_clientId', id);
    }
    return id;
  }

  function redirectHome(reason) {
    alert(reason);
    window.location.href = '/';
  }
})();
