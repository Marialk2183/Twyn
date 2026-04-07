/**
 * CryptoHelper — Client-side End-to-End Encryption
 *
 * Protocol:
 *   1. Each user generates an ephemeral ECDH key pair (P-256 curve) on page load.
 *   2. Public keys are exchanged via Socket.IO (server relays, never stores or reads).
 *   3. Both users independently derive the SAME shared secret using ECDH.
 *   4. The shared secret is used to derive an AES-GCM-256 symmetric key.
 *   5. Every message is encrypted with AES-GCM using a fresh random IV (96-bit).
 *   6. Server stores only: base64(ciphertext) + base64(IV) — completely opaque.
 *   7. Decryption happens entirely in the browser.
 *
 * Why ECDH + AES-GCM?
 *   - ECDH provides Perfect Forward Secrecy (each session uses new keys)
 *   - AES-GCM provides authenticated encryption (detects tampering)
 *   - Web Crypto API — no third-party libraries needed, runs in the browser's
 *     secure context (uses native OS crypto primitives)
 */

const CryptoHelper = (() => {
  let _myKeyPair = null;   // ECDH key pair (private + public)
  let _sharedKey = null;   // Derived AES-GCM key
  let _myPublicKeyJwk = null; // Cached JWK export of our public key

  // ── Key Generation ─────────────────────────────────────────────────────────

  /**
   * Generate a new ephemeral ECDH key pair.
   * Call once per page session. Private key is NEVER exported or transmitted.
   */
  async function generateKeyPair() {
    _myKeyPair = await window.crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      false, // Private key is NOT extractable — cannot be exported/stolen
      ['deriveKey']
    );

    // Export public key as JWK string to share with peer
    const jwk = await window.crypto.subtle.exportKey('jwk', _myKeyPair.publicKey);
    _myPublicKeyJwk = JSON.stringify(jwk);

    return _myKeyPair;
  }

  /**
   * Return our public key as a JWK JSON string for transmission.
   */
  function getMyPublicKey() {
    if (!_myPublicKeyJwk) throw new Error('Key pair not generated yet');
    return _myPublicKeyJwk;
  }

  // ── Key Exchange ───────────────────────────────────────────────────────────

  /**
   * Derive the shared AES-GCM key using peer's ECDH public key.
   * Both users independently derive the SAME key — no key ever travels the wire.
   *
   * @param {string} peerPublicKeyJwk - JWK JSON string received from peer
   */
  async function deriveSharedKey(peerPublicKeyJwk) {
    if (!_myKeyPair) throw new Error('Key pair not generated');

    const peerPublicKey = await window.crypto.subtle.importKey(
      'jwk',
      JSON.parse(peerPublicKeyJwk),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [] // Public key has no usages
    );

    _sharedKey = await window.crypto.subtle.deriveKey(
      { name: 'ECDH', public: peerPublicKey },
      _myKeyPair.privateKey,
      { name: 'AES-GCM', length: 256 }, // AES-256-GCM
      false, // Derived key is NOT extractable
      ['encrypt', 'decrypt']
    );

    return _sharedKey;
  }

  // ── Encrypt / Decrypt ──────────────────────────────────────────────────────

  /**
   * Encrypt a plaintext string with AES-GCM-256.
   * A fresh random 96-bit IV is generated for every message.
   *
   * @param {string} plaintext
   * @returns {{ encryptedContent: string, iv: string }} base64-encoded values
   */
  async function encrypt(plaintext) {
    if (!_sharedKey) throw new Error('No shared key established. Wait for peer to join.');

    const iv = window.crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV
    const encoded = new TextEncoder().encode(plaintext);

    const ciphertext = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      _sharedKey,
      encoded
    );

    return {
      encryptedContent: _arrayBufferToBase64(ciphertext),
      iv: _arrayBufferToBase64(iv.buffer)
    };
  }

  /**
   * Decrypt a ciphertext back to plaintext.
   *
   * @param {string} encryptedContentB64 - base64-encoded ciphertext
   * @param {string} ivB64               - base64-encoded IV
   * @returns {string} plaintext
   */
  async function decrypt(encryptedContentB64, ivB64) {
    if (!_sharedKey) throw new Error('No shared key established.');

    const ciphertext = _base64ToArrayBuffer(encryptedContentB64);
    const iv = _base64ToArrayBuffer(ivB64);

    const decrypted = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv) },
      _sharedKey,
      ciphertext
    );

    return new TextDecoder().decode(decrypted);
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  function hasSharedKey() { return _sharedKey !== null; }
  function hasKeyPair()   { return _myKeyPair !== null; }

  // ── Private Utilities ──────────────────────────────────────────────────────

  function _arrayBufferToBase64(buffer) {
    // Chunked to avoid slow string concatenation on large buffers (e.g. encrypted audio)
    const bytes  = new Uint8Array(buffer);
    const CHUNK  = 8192;
    let binary   = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function _base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  return {
    generateKeyPair,
    getMyPublicKey,
    deriveSharedKey,
    encrypt,
    decrypt,
    hasSharedKey,
    hasKeyPair
  };
})();
