/**
 * app.js — Landing page logic
 */

// ── Particle Background ────────────────────────────────────────────────────
(function initParticles() {
  const canvas = document.getElementById('bg-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  const COUNT = 70;
  const COLORS = ['rgba(0,212,170,', 'rgba(124,58,237,', 'rgba(6,182,212,'];

  const particles = Array.from({ length: COUNT }, () => ({
    x:   Math.random() * window.innerWidth,
    y:   Math.random() * window.innerHeight,
    vx:  (Math.random() - 0.5) * 0.35,
    vy:  (Math.random() - 0.5) * 0.35,
    r:   Math.random() * 1.8 + 0.4,
    op:  Math.random() * 0.45 + 0.08,
    col: COLORS[Math.floor(Math.random() * COLORS.length)]
  }));

  let rafId;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const w = canvas.width, h = canvas.height;

    for (let i = 0; i < COUNT; i++) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0) p.x = w;
      if (p.x > w) p.x = 0;
      if (p.y < 0) p.y = h;
      if (p.y > h) p.y = 0;

      // Draw particle dot
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.col + p.op + ')';
      ctx.fill();

      // Draw lines to nearby particles
      for (let j = i + 1; j < COUNT; j++) {
        const q  = particles[j];
        const dx = p.x - q.x;
        const dy = p.y - q.y;
        const d  = Math.sqrt(dx * dx + dy * dy);
        if (d < 130) {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
          ctx.strokeStyle = 'rgba(0,212,170,' + (0.12 * (1 - d / 130)) + ')';
          ctx.lineWidth = 0.6;
          ctx.stroke();
        }
      }
    }
    rafId = requestAnimationFrame(draw);
  }
  draw();

  // Pause when tab is hidden to save CPU
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(rafId);
    else draw();
  });
})();

// ── Typewriter Effect on subtitle ─────────────────────────────────────────
(function typewriter() {
  const el = document.getElementById('logo-sub');
  if (!el) return;
  const phrases = [
    'End-to-end encrypted · 2-person private rooms',
    'Voice & video calls · Zero knowledge server',
    'Messages vanish in 24 hours · No accounts'
  ];
  let phraseIdx = 0, charIdx = 0, deleting = false;

  function tick() {
    const phrase = phrases[phraseIdx];
    if (!deleting) {
      el.textContent = phrase.slice(0, ++charIdx);
      if (charIdx === phrase.length) {
        deleting = true;
        setTimeout(tick, 2600);
        return;
      }
      setTimeout(tick, 42);
    } else {
      el.textContent = phrase.slice(0, --charIdx);
      if (charIdx === 0) {
        deleting = false;
        phraseIdx = (phraseIdx + 1) % phrases.length;
        setTimeout(tick, 400);
        return;
      }
      setTimeout(tick, 22);
    }
  }
  setTimeout(tick, 900);
})();

// ── Landing Page Logic ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const createBtn = document.getElementById('create-btn');
  const joinBtn   = document.getElementById('join-btn');
  const joinInput = document.getElementById('join-input');
  const statusMsg = document.getElementById('status-msg');
  const spinner   = document.getElementById('spinner');

  function setStatus(msg, type = 'info') {
    statusMsg.textContent = msg;
    statusMsg.className = `status-msg status-${type}`;
    statusMsg.style.display = 'block';
  }

  function setLoading(loading) {
    spinner.style.display = loading ? 'inline-block' : 'none';
    createBtn.disabled = loading;
    joinBtn.disabled   = loading;
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
      setTimeout(() => { window.location.href = `/room/${roomId}`; }, 400);
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
    let roomId = raw;
    const urlMatch = raw.match(/\/room\/([A-Za-z0-9]{6})$/);
    if (urlMatch) roomId = urlMatch[1];
    roomId = roomId.toUpperCase();

    if (!/^[A-Z0-9]{6}$/.test(roomId)) {
      setStatus('Please enter a valid 6-character room code (e.g. ABX92K).', 'error');
      joinInput.focus();
      joinInput.classList.add('shake');
      setTimeout(() => joinInput.classList.remove('shake'), 500);
      return;
    }
    window.location.href = `/room/${roomId}`;
  }

  // Auto-focus join input on paste
  document.addEventListener('paste', (e) => {
    const text = e.clipboardData.getData('text');
    if (text && (text.includes('/room/') || /^[A-Z0-9]{6}$/.test(text.trim()))) {
      joinInput.focus();
    }
  });
});
