// PDFPager scan rendezvous API.
//
// The PDFPager frontend is a pure static site; this is its only backend.
// It exists solely to pair a desktop session with a phone for cover scanning:
//   desktop  → POST /api/scan/session            create session, get QR + short URL
//   phone    → GET  /s/:code                     short URL → redirect to /scan.html?token=…
//   phone    → POST /api/scan/session/:token/connected
//   phone    → POST /api/scan/upload/:token      multipart image (flattened scan)
//   desktop  → GET  /api/scan/session/:token     poll status (connected / hasImage)
//   desktop  → GET  /api/scan/session/:token/image
//   desktop  → DELETE /api/scan/session/:token   close / consume
//
// Everything is in-memory with a 15-minute TTL — no DB, no persistent state.
// Images are scan-quality JPEG/PNG capped at 10MB and held only until the
// desktop fetches them or the session expires.

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3600;
const SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const app = express();
app.set('trust proxy', true);

// ---------------------------------------------------------------- sessions
// token  → session  (desktop + phone both use the token)
// short  → token    (short code only exists to make the typed URL small)
// pin    → token    (4-digit pairing code typed at /scan on the phone)
const sessions = new Map();
const shortCodes = new Map();
const pins = new Map();

// Unambiguous alphabet (no 0/O, 1/I/L) — code is typed by hand on a phone.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newShortCode() {
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    const bytes = crypto.randomBytes(5);
    for (let i = 0; i < 5; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (!shortCodes.has(code)) return code;
  }
  throw new Error('could not allocate short code');
}

// 4-digit pairing PIN, unique among live sessions. The space is only 10k —
// acceptable for short-lived sessions on an internal tool, backed by a hard
// rate limit on /api/scan/claim.
function newPin() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const pin = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    if (!pins.has(pin)) return pin;
  }
  throw new Error('could not allocate pin');
}

function createSession() {
  const token = crypto.randomBytes(16).toString('hex');
  const code = newShortCode();
  const pin = newPin();
  const session = {
    token,
    code,
    pin,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
    connected: false,        // phone opened the scan page
    image: null,             // Buffer
    imageMime: null,
    uploadedAt: null,
  };
  sessions.set(token, session);
  shortCodes.set(code, token);
  pins.set(pin, token);
  return session;
}

function getLiveSession(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    destroySession(s);
    return null;
  }
  return s;
}

function destroySession(s) {
  sessions.delete(s.token);
  shortCodes.delete(s.code);
  pins.delete(s.pin);
}

// Periodic sweep so abandoned sessions don't pile up.
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (now > s.expiresAt) destroySession(s);
  }
}, 60 * 1000).unref();

// ------------------------------------------------------------- rate limit
// Fixed-window per-IP limiter; the API is exposed unauthenticated, so keep
// abuse cheap to shrug off.
const rlBuckets = new Map();
function rateLimit(limit, windowMs) {
  return (req, res, next) => {
    const key = `${req.path.split('/').slice(0, 3).join('/')}|${req.ip}`;
    const now = Date.now();
    let b = rlBuckets.get(key);
    if (!b || now > b.reset) {
      b = { count: 0, reset: now + windowMs };
      rlBuckets.set(key, b);
    }
    if (++b.count > limit) {
      return res.status(429).json({ success: false, error: 'Too many requests' });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rlBuckets) if (now > b.reset) rlBuckets.delete(k);
}, 60 * 1000).unref();

// ---------------------------------------------------------------- uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Only JPEG, PNG or WEBP images are allowed'), ok);
  },
});

// ------------------------------------------------------------------ routes

app.get('/api/scan/health', (req, res) => {
  res.json({ ok: true, sessions: sessions.size });
});

// Desktop: create a pairing session. The short URL is built from the
// forwarded host so it matches whichever domain the dashboard is open on.
app.post('/api/scan/session', rateLimit(15, 60 * 1000), async (req, res) => {
  try {
    const session = createSession();
    const proto = req.get('x-forwarded-proto') || 'https';
    const host = req.get('x-forwarded-host') || req.get('host');
    const shortUrl = `${proto}://${host}/s/${session.code}`;
    const scanUrl = `${proto}://${host}/scan.html?token=${session.token}`;
    const qrDataUrl = await QRCode.toDataURL(shortUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 280,
    });
    res.json({
      success: true,
      token: session.token,
      code: session.code,
      pin: session.pin,
      quickUrl: `${host}/scan`,
      shortUrl,
      scanUrl,
      qrDataUrl,
      expiresAt: session.expiresAt,
    });
  } catch (err) {
    console.error('create session failed:', err);
    res.status(500).json({ success: false, error: 'Could not create scan session' });
  }
});

// Phone: claim a session by its 4-digit PIN (typed at /scan). Tightly
// rate-limited — the PIN space is small by design.
app.post('/api/scan/claim/:pin', rateLimit(10, 60 * 1000), (req, res) => {
  const pin = (req.params.pin || '').trim();
  const token = pins.get(pin);
  const s = token && getLiveSession(token);
  if (!s) return res.status(404).json({ success: false, error: 'Invalid or expired code' });
  res.json({ success: true, token: s.token });
});

// Phone: short URL → scan page (static, served by nginx alongside the SPA).
app.get('/s/:code', (req, res) => {
  const token = shortCodes.get((req.params.code || '').toUpperCase());
  const s = token && getLiveSession(token);
  if (!s) return res.status(404).send('Scan link expired or not found. Generate a new one on the desktop.');
  res.redirect(302, `/scan.html?token=${s.token}`);
});

// Desktop: poll.
app.get('/api/scan/session/:token', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const s = getLiveSession(req.params.token);
  if (!s) return res.status(404).json({ success: false, error: 'Session not found or expired' });
  res.json({
    success: true,
    connected: s.connected,
    hasImage: !!s.image,
    uploadedAt: s.uploadedAt,
    expiresAt: s.expiresAt,
  });
});

// Phone: announce the scan page is open (drives "phone connected" UI).
app.post('/api/scan/session/:token/connected', (req, res) => {
  const s = getLiveSession(req.params.token);
  if (!s) return res.status(404).json({ success: false, error: 'Session not found or expired' });
  s.connected = true;
  res.json({ success: true });
});

// Phone: upload the flattened scan.
app.post(
  '/api/scan/upload/:token',
  rateLimit(30, 60 * 1000),
  (req, res, next) => {
    if (!getLiveSession(req.params.token)) {
      return res.status(404).json({ success: false, error: 'Session not found or expired' });
    }
    next();
  },
  upload.single('image'),
  (req, res) => {
    const s = getLiveSession(req.params.token);
    if (!s) return res.status(404).json({ success: false, error: 'Session not found or expired' });
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ success: false, error: 'Missing image upload' });
    }
    s.image = req.file.buffer;
    s.imageMime = req.file.mimetype;
    s.uploadedAt = Date.now();
    // Give the desktop time to collect even if the 15min window is nearly up.
    s.expiresAt = Math.max(s.expiresAt, Date.now() + 5 * 60 * 1000);
    res.json({ success: true });
  }
);

// Desktop: fetch the uploaded image.
app.get('/api/scan/session/:token/image', (req, res) => {
  const s = getLiveSession(req.params.token);
  if (!s || !s.image) return res.status(404).json({ success: false, error: 'No image available' });
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', s.imageMime || 'image/jpeg');
  res.send(s.image);
});

// Desktop: done with the session (modal closed or image consumed).
app.delete('/api/scan/session/:token', (req, res) => {
  const s = sessions.get(req.params.token);
  if (s) destroySession(s);
  res.json({ success: true });
});

// Multer errors (file too large, wrong type) → clean JSON.
app.use((err, req, res, next) => {
  if (err) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ success: false, error: err.message });
  }
  next();
});

app.listen(PORT, () => {
  console.log(`pdfpager-api listening on :${PORT}`);
});
