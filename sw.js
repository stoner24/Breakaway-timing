// sw.js — Breakaway Timing Service Worker
// Handles background GPS pinging even when screen is off

const SW_VERSION = 'bt-tracker-v2';
let pingInterval = null;
let sessionData = null;

// ── Message handler from the main page ──────────────────────────────────────
self.addEventListener('message', (event) => {
  const { type, payload } = event.data;

  if (type === 'START_TRACKING') {
    sessionData = payload; // { sessionId, token, bib, name, expiresAt, firebaseUrl }
    startPinging();
    event.ports[0]?.postMessage({ ok: true });
  }

  if (type === 'STOP_TRACKING') {
    stopPinging();
    sessionData = null;
    event.ports[0]?.postMessage({ ok: true });
  }

  if (type === 'PING_STATUS') {
    event.ports[0]?.postMessage({ active: !!pingInterval, session: sessionData });
  }
});

// ── Start interval pinging ───────────────────────────────────────────────────
function startPinging() {
  stopPinging(); // clear any existing interval
  pingNow();     // immediate first ping
  pingInterval = setInterval(pingNow, 5 * 60 * 1000); // every 5 minutes
}

function stopPinging() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

// ── Core ping function ───────────────────────────────────────────────────────
async function pingNow() {
  if (!sessionData) return;

  // ── Expiry check — stop tracking if session has expired ──
  if (Date.now() > sessionData.expiresAt) {
    stopPinging();
    // Mark session inactive in Firebase
    await writeToFirebase({ active: false, stoppedAt: Date.now() });
    // Notify all open clients
    broadcastToClients({ type: 'SESSION_EXPIRED' });
    return;
  }

  // ── Get GPS position ──
  try {
    const position = await getPosition();
    await writeToFirebase({
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: Math.round(position.coords.accuracy),
      timestamp: Date.now(),
      active: true,
    });
    broadcastToClients({
      type: 'PING_SUCCESS',
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      timestamp: Date.now(),
    });
  } catch (err) {
    console.warn('[SW] GPS error:', err.message);
    broadcastToClients({ type: 'PING_ERROR', message: err.message });
  }
}

// ── Geolocation wrapper (Promise-based) ─────────────────────────────────────
function getPosition() {
  return new Promise((resolve, reject) => {
    self.navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 30000,
      maximumAge: 60000,
    });
  });
}

// ── Write to Firebase REST API ───────────────────────────────────────────────
async function writeToFirebase(data) {
  if (!sessionData?.firebaseUrl || !sessionData?.dbPath) {
    console.warn('[SW] Missing firebaseUrl or dbPath', JSON.stringify(sessionData));
    return;
  }

  // No auth token needed — Firebase rules allow open writes to tracker/
  const url = `${sessionData.firebaseUrl}/${sessionData.dbPath}.json`;

  const payload = {
    active: data.active !== undefined ? data.active : true,
    expiresAt: sessionData.expiresAt,
  };

  if (data.lat && data.lng) {
    payload.latest = {
      lat: data.lat,
      lng: data.lng,
      accuracy: data.accuracy || null,
      ts: data.timestamp || Date.now(),
    };
  }

  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn('[SW] Firebase write error:', res.status, text);
    }
  } catch (err) {
    console.warn('[SW] Firebase write failed:', err.message);
  }
}

// ── Broadcast message to all open pages ─────────────────────────────────────
async function broadcastToClients(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach((client) => client.postMessage(message));
}

// ── Install & activate ───────────────────────────────────────────────────────
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
