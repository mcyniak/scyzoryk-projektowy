// Prosty, reczny limiter prob logowania dla korzennego server.js (celowo bez
// Express, wiec express-rate-limit tu nie pasuje - 5 aplikacji-dzieci maja
// juz express-rate-limit jako zaleznosc i uzywaja go bezposrednio na wlasnych
// trasach logowania, jesli kiedys takie dostana).
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

const attempts = new Map();

function keyFor(ip, username) {
  return `${ip}|${String(username || '').trim().toLowerCase()}`;
}

function isRateLimited(ip, username) {
  const entry = attempts.get(keyFor(ip, username));
  if (!entry) return false;
  if (Date.now() - entry.windowStart > WINDOW_MS) return false;
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailedAttempt(ip, username) {
  const key = keyFor(ip, username);
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    attempts.set(key, { count: 1, windowStart: now });
  } else {
    entry.count += 1;
  }
}

function recordSuccess(ip, username) {
  attempts.delete(keyFor(ip, username));
}

function cleanupStaleAttempts() {
  const now = Date.now();
  for (const [key, entry] of attempts.entries()) {
    if (now - entry.windowStart > WINDOW_MS) attempts.delete(key);
  }
}

const cleanupTimer = setInterval(cleanupStaleAttempts, 30 * 60 * 1000);
cleanupTimer.unref?.();

module.exports = { isRateLimited, recordFailedAttempt, recordSuccess, MAX_ATTEMPTS, WINDOW_MS };
