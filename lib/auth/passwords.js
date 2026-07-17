const crypto = require('crypto');

// Format zapisu: scrypt$N$r$p$saltHex$hashHex - parametry kosztu sa zapisane
// razem z hashem, wiec mozna je pozniej podniesc bez uniewazniania juz
// zapisanych hasel (stare wpisy nadal beda weryfikowane wg parametrow,
// z jakimi powstaly).
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

function scryptAsync(password, salt, N, r, p) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_LENGTH, { N, r, p }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

async function hashPassword(plain) {
  if (!plain || typeof plain !== 'string') throw new Error('Haslo nie moze byc puste.');
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(plain, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(plain, stored) {
  if (!plain || !stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch (_) {
    return false;
  }
  if (!salt.length || !expected.length) return false;
  const actual = await scryptAsync(plain, salt, N, r, p);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

module.exports = { hashPassword, verifyPassword };
