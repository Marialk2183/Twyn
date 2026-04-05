/**
 * app.js — Landing page logic
 * Handles room creation and navigation to /room/:roomId
 */

document.addEventListener('DOMContentLoaded', () => {
  const createBtn  = document.getElementById('create-btn');
  const joinBtn    = document.getElementById('join-btn');
  const joinInput  = document.getElementById('join-input');
  const statusMsg  = document.getElementById('status-msg');
  const spinner    = document.getElementById('spinner');

  function setStatus(msg, type = 'info') {
    statusMsg.textContent = msg;
    statusMsg.className = `status-msg status-${type}`;
    statusMsg.style.display = 'block';
  }

  function setLoading(loading) {
    spinner.style.display = loading ? 'inline-block' : 'none';
    createBtn.disabled = loading;
    joinBtn.disabled = loading;
  }

  // ── Create Room ────────────────────────────────────────────────────────────
  createBtn.addEventListener('click', async () => {
    setLoading(true);
    setStatus('Creating your private room…', 'info');

    try {
      const res = await fetch('/api/rooms/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Server error (${res.status})`);
      }

      const { roomId } = await res.json();
      setStatus('Room created! Redirecting…', 'success');
      window.location.href = `/room/${roomId}`;
    } catch (err) {
      setStatus(err.message || 'Failed to create room. Please try again.', 'error');
      setLoading(false);
    }
  });

  // ── Join Room via input ────────────────────────────────────────────────────
  joinBtn.addEventListener('click', () => navigateToRoom());
  joinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') navigateToRoom();
  });

  function navigateToRoom() {
    const raw = joinInput.value.trim();

    // Accept full URL or just room ID
    let roomId = raw;
    const urlMatch = raw.match(/\/room\/([A-Za-z0-9]{6})$/);
    if (urlMatch) roomId = urlMatch[1];

    roomId = roomId.toUpperCase();

    if (!/^[A-Z0-9]{6}$/.test(roomId)) {
      setStatus('Please enter a valid 6-character room code (e.g. ABX92K).', 'error');
      joinInput.focus();
      return;
    }

    window.location.href = `/room/${roomId}`;
  }

  // Auto-focus join input on paste detection
  document.addEventListener('paste', (e) => {
    const text = e.clipboardData.getData('text');
    if (text && (text.includes('/room/') || /^[A-Z0-9]{6}$/.test(text.trim()))) {
      joinInput.focus();
    }
  });
});
