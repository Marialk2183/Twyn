/**
 * chat.js — Room chat page logic
 *
 * Features: E2EE messaging · Seen receipts · Online/last seen · Typing indicator
 *           Voice & video calls (WebRTC) · Emoji reactions · Sound feedback
 *           Auto-resize input · Character counter
 */

(async function () {
  // ── Constants ──────────────────────────────────────────────────────────────
  const TYPING_DEBOUNCE_MS = 1500;
  const REACTIONS          = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
  const STUN_SERVERS       = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  // ── Room / Session ─────────────────────────────────────────────────────────
  const roomId  = getRoomIdFromUrl();
  if (!roomId) return redirectHome('Invalid room URL.');
  const clientId = getOrCreateClientId();

  // ── Chat State ─────────────────────────────────────────────────────────────
  let mySlotIndex      = null;
  let chatEnabled      = false;
  let pendingHistory   = null;
  let myPublicKeySent  = false;
  let sharedKeyDerived = false;
  let typingTimer      = null;
  let isTyping         = false;

  // ── Online / Last Seen ─────────────────────────────────────────────────────
  let peerOnline   = false;
  let peerLastSeen = null;

  // ── Seen Receipts ──────────────────────────────────────────────────────────
  const seenSet = new Set();

  // ── Reactions ─────────────────────────────────────────────────────────────
  // messageId → { mine: emoji|null, theirs: emoji|null }
  const reactionState = new Map();
  let pickerTarget = null; // currently-open picker bubble element

  // ── Call State ────────────────────────────────────────────────────────────
  let localStream     = null;
  let peerConnection  = null;
  let currentCallType = null;
  let callTimer       = null;
  let callSeconds     = 0;
  let isMuted          = false;
  let isCameraOff      = false;
  let incomingOffer    = null;
  let incomingType     = null;
  let currentFacingMode = 'user'; // 'user' = front, 'environment' = back

  // ── Audio Context (lazy) ──────────────────────────────────────────────────
  let audioCtx = null;
  function getAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  function playTone(freq1, freq2, dur, vol = 0.06) {
    try {
      const ctx  = getAudio();
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq1, ctx.currentTime);
      if (freq2) osc.frequency.exponentialRampToValueAtTime(freq2, ctx.currentTime + dur);
      gain.gain.setValueAtTime(vol, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
      osc.start();
      osc.stop(ctx.currentTime + dur);
    } catch { /* AudioContext blocked or unsupported */ }
  }

  const sound = {
    send:    () => playTone(700, 900, 0.08, 0.05),
    receive: () => playTone(520, 780, 0.12, 0.05),
    secure:  () => { playTone(523, 0, 0.08); setTimeout(() => playTone(659, 0, 0.08), 120); setTimeout(() => playTone(784, 0, 0.15), 240); },
    callIn:  () => { /* handled by repeated tones in incoming call */ },
    react:   () => playTone(880, 0, 0.06, 0.04)
  };

  // ── DOM References ─────────────────────────────────────────────────────────
  const messagesEl        = document.getElementById('messages');
  const inputEl           = document.getElementById('message-input');
  const sendBtn           = document.getElementById('send-btn');
  const statusBar         = document.getElementById('status-bar');
  const typingEl          = document.getElementById('typing-indicator');
  const encryptBadge      = document.getElementById('encrypt-badge');
  const roomIdDisplay     = document.getElementById('room-id-display');
  const copyLinkBtn       = document.getElementById('copy-link-btn');
  const waitingOverlay    = document.getElementById('waiting-overlay');
  const waitingMsg        = document.getElementById('waiting-msg');
  const errorOverlay      = document.getElementById('error-overlay');
  const errorMsg          = document.getElementById('error-msg');
  const peerStatusDot     = document.getElementById('peer-status-dot');
  const peerStatusText    = document.getElementById('peer-status-text');
  const voiceCallBtn      = document.getElementById('voice-call-btn');
  const videoCallBtn      = document.getElementById('video-call-btn');
  const incomingCallModal = document.getElementById('incoming-call-modal');
  const incomingCallLabel = document.getElementById('incoming-call-label');
  const acceptCallBtn     = document.getElementById('accept-call-btn');
  const rejectCallBtn     = document.getElementById('reject-call-btn');
  const voiceCallOverlay  = document.getElementById('voice-call-overlay');
  const voiceCallTimer    = document.getElementById('voice-call-timer');
  const voiceMuteBtn      = document.getElementById('voice-mute-btn');
  const voiceEndBtn       = document.getElementById('voice-end-btn');
  const videoCallOverlay  = document.getElementById('video-call-overlay');
  const videoCallTimer    = document.getElementById('video-call-timer');
  const remoteVideoEl     = document.getElementById('remote-video');
  const localVideoEl      = document.getElementById('local-video');
  const remoteAudioEl     = document.getElementById('remote-audio');
  const videoMuteBtn      = document.getElementById('video-mute-btn');
  const videoEndBtn       = document.getElementById('video-end-btn');
  const videoCameraBtn    = document.getElementById('video-camera-btn');
  const videoFlipBtn      = document.getElementById('video-flip-btn');

  if (roomIdDisplay) roomIdDisplay.textContent = roomId;

  // ── Auto-resize textarea ──────────────────────────────────────────────────
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    updateCharCount();
  });

  // Character counter
  const charCountEl = document.createElement('span');
  charCountEl.className = 'char-count';
  inputEl.parentElement.appendChild(charCountEl);
  function updateCharCount() {
    const len  = inputEl.value.length;
    const left = 4000 - len;
    charCountEl.textContent = len > 3600 ? left : '';
    charCountEl.className   = 'char-count' + (left < 200 ? ' warn' : '') + (left < 50 ? ' limit' : '');
  }

  // ── Validate room before connecting ───────────────────────────────────────
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

  // ── Socket.IO ─────────────────────────────────────────────────────────────
  const socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    setStatus('Joining room…', 'connecting');
    socket.emit('join-room', { roomId, clientId });
  });

  socket.on('connect_error', () => setStatus('Connection lost. Reconnecting…', 'error'));

  socket.on('disconnect', () => {
    setStatus('Disconnected from server.', 'error');
    setChatEnabled(false);
  });

  // ── Room Events ────────────────────────────────────────────────────────────
  socket.on('joined', async ({ slotIndex, userCount, reconnected }) => {
    mySlotIndex = slotIndex;
    await CryptoHelper.generateKeyPair();

    if (userCount >= 2) {
      broadcastPublicKey();
      setStatus('Peer present. Establishing secure channel…', 'connecting');
      setPeerOnline(true);
    } else {
      showWaiting();
      setStatus('Waiting for peer to join…', 'waiting');
      setPeerOnline(false);
    }
  });

  socket.on('peer-joined', () => {
    hideWaiting();
    setStatus('Peer joined. Establishing secure channel…', 'connecting');
    setPeerOnline(true);
    broadcastPublicKey();
  });

  socket.on('peer-reconnected', () => {
    sharedKeyDerived = false;
    myPublicKeySent  = false;
    setPeerOnline(true);
    broadcastPublicKey();
    setStatus('Peer reconnected. Re-establishing secure channel…', 'connecting');
  });

  socket.on('peer-disconnected', ({ lastSeen }) => {
    setChatEnabled(false);
    sharedKeyDerived = false;
    myPublicKeySent  = false;
    peerLastSeen     = lastSeen || null;
    setPeerOnline(false);
    showWaiting('Peer disconnected. Waiting for them to reconnect…');
    setStatus('Peer disconnected.', 'waiting');
    typingEl.style.display = 'none';
    if (peerConnection) endCall(false);
    hideIncomingCallModal();
  });

  socket.on('join-error', ({ message }) => showError(message));

  // ── Key Exchange ───────────────────────────────────────────────────────────
  socket.on('peer-public-key', async ({ publicKey }) => {
    if (sharedKeyDerived) sharedKeyDerived = false;
    try {
      await CryptoHelper.deriveSharedKey(publicKey);
      sharedKeyDerived = true;
      broadcastPublicKey();
      setChatEnabled(true);
      setStatus('End-to-end encrypted', 'secure');
      encryptBadge.style.display = 'inline-flex';
      sound.secure();
      hideWaiting();
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
    if (!messages || !messages.length) return;
    if (chatEnabled) await renderHistory(messages);
    else pendingHistory = messages;
  });

  async function renderHistory(messages) {
    for (const msg of messages) await renderMessage(msg, true);
    scrollToBottom();
  }

  // ── Incoming Messages ──────────────────────────────────────────────────────
  socket.on('new-message', async (msg) => {
    if (!chatEnabled) return;
    await renderMessage(msg, false);
    scrollToBottom();

    if (msg.senderIndex !== mySlotIndex && msg._id && !seenSet.has(msg._id)) {
      seenSet.add(msg._id);
      socket.emit('message-seen', { roomId, messageId: msg._id });
      sound.receive();
    }
  });

  // ── Seen Receipt (inbound) ─────────────────────────────────────────────────
  socket.on('message-seen', ({ messageId }) => {
    if (!messageId) return;
    const tick = document.querySelector(`.msg-tick[data-msg-id="${CSS.escape(messageId)}"]`);
    if (tick) {
      tick.textContent = '✓✓';
      tick.classList.add('seen');
    }
  });

  // ── Emoji Reactions ────────────────────────────────────────────────────────
  socket.on('message-reaction', ({ messageId, emoji }) => {
    applyReaction(messageId, emoji, 'theirs');
  });

  function applyReaction(messageId, emoji, who) {
    if (!reactionState.has(messageId)) reactionState.set(messageId, { mine: null, theirs: null });
    const state = reactionState.get(messageId);
    state[who] = emoji;

    const wrapper  = document.querySelector(`.message-wrapper[data-msg-id="${CSS.escape(messageId)}"]`);
    if (!wrapper) return;

    let row = wrapper.querySelector('.reaction-row');
    if (!row) {
      row = document.createElement('div');
      row.className = 'reaction-row';
      wrapper.appendChild(row);
    }
    row.innerHTML = '';

    // Build pills
    const combined = {};
    if (state.mine)   combined[state.mine]   = (combined[state.mine]   || 0) + 1;
    if (state.theirs) combined[state.theirs]  = (combined[state.theirs]  || 0) + 1;

    for (const [em, count] of Object.entries(combined)) {
      const pill = document.createElement('span');
      pill.className = 'reaction-pill' + (em === state.mine ? ' mine-reaction' : '');
      pill.textContent = `${em}${count > 1 ? ' ' + count : ''}`;
      row.appendChild(pill);
    }

    sound.react();
  }

  // ── Render Message Bubble ─────────────────────────────────────────────────
  async function renderMessage(msg, isHistory) {
    const isMine = msg.senderIndex === mySlotIndex;
    let text = '';
    try {
      text = await CryptoHelper.decrypt(msg.encryptedContent, msg.iv);
    } catch {
      text = '[Could not decrypt message]';
    }

    const wrapper = document.createElement('div');
    wrapper.className = `message-wrapper ${isMine ? 'mine' : 'theirs'}`;
    if (msg._id) wrapper.dataset.msgId = msg._id;

    const label = document.createElement('span');
    label.className   = 'message-label';
    label.textContent = isMine ? 'You' : 'Other';

    // Bubble
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.textContent = text;

    // Reaction picker (hidden, shows on hover)
    const picker = document.createElement('div');
    picker.className = 'reaction-picker';
    REACTIONS.forEach(em => {
      const btn = document.createElement('button');
      btn.className   = 'reaction-btn';
      btn.textContent = em;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!msg._id) return;
        applyReaction(msg._id, em, 'mine');
        socket.emit('message-reaction', { roomId, messageId: msg._id, emoji: em });
        closePicker();
      });
      picker.appendChild(btn);
    });
    bubble.appendChild(picker);

    // Show picker on bubble hover
    bubble.addEventListener('mouseenter', () => {
      if (!chatEnabled) return;
      closePicker();
      pickerTarget = picker;
      picker.classList.add('visible');
    });
    bubble.addEventListener('mouseleave', (e) => {
      if (!picker.contains(e.relatedTarget)) {
        setTimeout(() => {
          if (!picker.matches(':hover')) {
            picker.classList.remove('visible');
            if (pickerTarget === picker) pickerTarget = null;
          }
        }, 180);
      }
    });
    picker.addEventListener('mouseleave', () => {
      picker.classList.remove('visible');
      if (pickerTarget === picker) pickerTarget = null;
    });

    // Meta row
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const time = document.createElement('span');
    time.className   = 'message-time';
    time.textContent = formatTime(msg.timestamp);
    meta.appendChild(time);

    if (isMine && !isHistory && msg._id) {
      const tick = document.createElement('span');
      tick.className     = 'msg-tick';
      tick.dataset.msgId = msg._id;
      tick.textContent   = '✓';
      meta.appendChild(tick);
    }

    wrapper.appendChild(label);
    wrapper.appendChild(bubble);
    wrapper.appendChild(meta);
    messagesEl.appendChild(wrapper);

    if (!isHistory) wrapper.classList.add('message-new');
  }

  function closePicker() {
    if (pickerTarget) {
      pickerTarget.classList.remove('visible');
      pickerTarget = null;
    }
  }
  document.addEventListener('click', closePicker);

  // ── Send Message ───────────────────────────────────────────────────────────
  async function sendMessage() {
    if (!chatEnabled) return;
    const text = inputEl.value.trim();
    if (!text) return;

    inputEl.value = '';
    inputEl.style.height = 'auto';
    updateCharCount();
    stopTypingIndicator();

    try {
      const { encryptedContent, iv } = await CryptoHelper.encrypt(text);
      socket.emit('send-message', { roomId, encryptedContent, iv });
      sound.send();
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

  socket.on('peer-typing', ({ isTyping: pt }) => {
    typingEl.style.display = pt ? 'flex' : 'none';
    if (pt) scrollToBottom();
  });

  // ── Copy Room Link ─────────────────────────────────────────────────────────
  copyLinkBtn.addEventListener('click', async () => {
    const link = `${window.location.origin}/room/${roomId}`;
    try {
      await navigator.clipboard.writeText(link);
      copyLinkBtn.textContent = '✓ Copied!';
      setTimeout(() => (copyLinkBtn.textContent = 'Copy Link'), 2000);
    } catch {
      prompt('Copy this link and share it:', link);
    }
  });

  // ── Call Button Events ────────────────────────────────────────────────────
  voiceCallBtn.addEventListener('click', () => startCall('audio'));
  videoCallBtn.addEventListener('click', () => startCall('video'));
  acceptCallBtn.addEventListener('click', acceptCall);
  rejectCallBtn.addEventListener('click', rejectCall);
  voiceMuteBtn.addEventListener('click', toggleMute);
  voiceEndBtn.addEventListener('click',  () => endCall(true));
  videoMuteBtn.addEventListener('click', toggleMute);
  videoCameraBtn.addEventListener('click', toggleCamera);
  videoFlipBtn.addEventListener('click', flipCamera);
  videoEndBtn.addEventListener('click',  () => endCall(true));

  // ── WebRTC: Start Outgoing Call ────────────────────────────────────────────
  async function startCall(callType) {
    if (!chatEnabled || !peerOnline || peerConnection) return;

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: callType === 'video'
      });
    } catch {
      showToast('Could not access ' + (callType === 'video' ? 'camera/microphone.' : 'microphone.'));
      return;
    }

    currentCallType = callType;
    peerConnection  = createPeerConnection();
    localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));

    if (callType === 'video') {
      localVideoEl.srcObject = localStream;
      videoCallOverlay.classList.add('show');
    } else {
      voiceCallOverlay.classList.add('show');
    }

    try {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socket.emit('call-offer', { roomId, offer, callType });
    } catch (err) {
      console.error('[Call] Offer failed:', err);
      endCall(false);
      showToast('Could not initiate call.');
    }
  }

  // ── WebRTC: Handle Incoming Offer ─────────────────────────────────────────
  socket.on('call-offer', ({ offer, callType }) => {
    if (peerConnection) { socket.emit('call-rejected', { roomId }); return; }
    incomingOffer = offer;
    incomingType  = callType;
    incomingCallLabel.textContent = callType === 'video' ? 'Incoming video call' : 'Incoming voice call';
    incomingCallModal.classList.add('show');
  });

  async function acceptCall() {
    hideIncomingCallModal();
    if (!incomingOffer) return;

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: incomingType === 'video'
      });
    } catch {
      showToast('Could not access ' + (incomingType === 'video' ? 'camera/microphone.' : 'microphone.'));
      socket.emit('call-rejected', { roomId });
      incomingOffer = null; incomingType = null;
      return;
    }

    currentCallType = incomingType;
    peerConnection  = createPeerConnection();
    localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));

    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(incomingOffer));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('call-answer', { roomId, answer });
    } catch (err) {
      console.error('[Call] Answer failed:', err);
      endCall(false);
      showToast('Could not connect call.');
      return;
    }

    if (currentCallType === 'video') {
      localVideoEl.srcObject = localStream;
      videoCallOverlay.classList.add('show');
    } else {
      voiceCallOverlay.classList.add('show');
    }

    incomingOffer = null; incomingType = null;
  }

  function rejectCall() {
    hideIncomingCallModal();
    socket.emit('call-rejected', { roomId });
    incomingOffer = null; incomingType = null;
  }

  socket.on('call-answer', async ({ answer }) => {
    if (!peerConnection) return;
    try { await peerConnection.setRemoteDescription(new RTCSessionDescription(answer)); }
    catch (err) { console.error('[Call] Set remote answer failed:', err); }
  });

  socket.on('ice-candidate', async ({ candidate }) => {
    if (!peerConnection) return;
    try { await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
  });

  socket.on('call-end', () => { endCall(false); showToast('Call ended.'); });
  socket.on('call-rejected', () => { endCall(false); showToast('Call declined.'); });

  // ── WebRTC: RTCPeerConnection Factory ─────────────────────────────────────
  function createPeerConnection() {
    const pc = new RTCPeerConnection(STUN_SERVERS);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('ice-candidate', { roomId, candidate });
    };

    pc.ontrack = ({ streams }) => {
      const stream = streams[0];
      if (currentCallType === 'video') remoteVideoEl.srcObject = stream;
      else remoteAudioEl.srcObject = stream;
      startCallTimer();
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        endCall(false);
        showToast('Call connection lost.');
      }
    };

    return pc;
  }

  // ── End Call ──────────────────────────────────────────────────────────────
  function endCall(notifyPeer) {
    if (notifyPeer && socket.connected) socket.emit('call-end', { roomId });
    if (localStream)    { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    if (callTimer)      { clearInterval(callTimer); callTimer = null; }

    callSeconds = 0; currentCallType = null; isMuted = false; isCameraOff = false; currentFacingMode = 'user';
    remoteAudioEl.srcObject = null;
    remoteVideoEl.srcObject = null;
    localVideoEl.srcObject  = null;
    voiceMuteBtn.classList.remove('active');
    videoMuteBtn.classList.remove('active');
    videoCameraBtn.classList.remove('active');
    voiceCallOverlay.classList.remove('show');
    videoCallOverlay.classList.remove('show');
  }

  function toggleMute() {
    if (!localStream) return;
    const t = localStream.getAudioTracks()[0];
    if (!t) return;
    isMuted = !isMuted;
    t.enabled = !isMuted;
    voiceMuteBtn.classList.toggle('active', isMuted);
    videoMuteBtn.classList.toggle('active', isMuted);
  }

  function toggleCamera() {
    if (!localStream) return;
    const t = localStream.getVideoTracks()[0];
    if (!t) return;
    isCameraOff = !isCameraOff;
    t.enabled = !isCameraOff;
    videoCameraBtn.classList.toggle('active', isCameraOff);
  }

  async function flipCamera() {
    if (!localStream || currentCallType !== 'video') return;

    currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';

    let newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: currentFacingMode }
      });
    } catch {
      showToast('Could not switch camera.');
      currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user'; // revert
      return;
    }

    const newVideoTrack = newStream.getVideoTracks()[0];

    // Swap track in peer connection without renegotiation
    if (peerConnection) {
      const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(newVideoTrack);
    }

    // Stop old video track and replace in localStream
    localStream.getVideoTracks().forEach(t => t.stop());
    localStream.removeTrack(localStream.getVideoTracks()[0]);
    localStream.addTrack(newVideoTrack);

    // Keep camera-off state consistent
    newVideoTrack.enabled = !isCameraOff;

    // Refresh local preview
    localVideoEl.srcObject = null;
    localVideoEl.srcObject = localStream;

    videoFlipBtn.classList.toggle('active', currentFacingMode === 'environment');
  }

  function startCallTimer() {
    if (callTimer) return;
    callTimer = setInterval(() => {
      callSeconds++;
      const m = String(Math.floor(callSeconds / 60)).padStart(2, '0');
      const s = String(callSeconds % 60).padStart(2, '0');
      const t = `${m}:${s}`;
      voiceCallTimer.textContent = t;
      videoCallTimer.textContent = t;
    }, 1000);
  }

  function hideIncomingCallModal() {
    incomingCallModal.classList.remove('show');
  }

  // ── Online Status ─────────────────────────────────────────────────────────
  function setPeerOnline(online) {
    peerOnline = online;
    peerStatusDot.classList.toggle('online', online);
    peerStatusText.textContent = online
      ? 'Online'
      : peerLastSeen
        ? 'Last seen ' + formatLastSeen(peerLastSeen)
        : 'Offline';
    voiceCallBtn.disabled = !(online && chatEnabled);
    videoCallBtn.disabled = !(online && chatEnabled);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function setChatEnabled(enabled) {
    chatEnabled = enabled;
    inputEl.disabled  = !enabled;
    sendBtn.disabled  = !enabled;
    voiceCallBtn.disabled = !(enabled && peerOnline);
    videoCallBtn.disabled = !(enabled && peerOnline);
    if (enabled) inputEl.focus();
  }

  function setStatus(text, type) {
    statusBar.textContent = text;
    statusBar.className   = `status-bar status-${type}`;
  }

  function showWaiting(msg = 'Waiting for other person to join…\nShare the link above!') {
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
    t.className   = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function formatTime(ts) {
    return new Date(ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatLastSeen(iso) {
    if (!iso) return 'recently';
    const d   = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const t   = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return sameDay ? `today at ${t}` : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` at ${t}`;
  }

  function getRoomIdFromUrl() {
    const m = window.location.pathname.match(/\/room\/([A-Za-z0-9]{6})$/);
    return m ? m[1].toUpperCase() : null;
  }

  function getOrCreateClientId() {
    let id = sessionStorage.getItem('mfchatt_clientId');
    if (!id) {
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
