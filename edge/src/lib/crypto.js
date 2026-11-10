// Password hashing (PBKDF2-SHA-256 through Web Crypto), session tokens and
// temporary passwords. No library: Web Crypto is built into the runtime.

// Iteration count for new password hashes. Each user row stores its own count,
// so this value can be raised later without breaking existing passwords.
// Measured on Bunny Edge Scripting in November 2026: about 200 ms per hash.
// See README, "Password hashing cost".
export const PBKDF2_ITERATIONS = 1_000_000;
export const MIN_PASSWORD_LENGTH = 10;

const encoder = new TextEncoder();

export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export function bytesToBase64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return bytesToHex(new Uint8Array(digest));
}

export async function pbkdf2Hex(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex), iterations },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

export async function hashPassword(password, iterations = PBKDF2_ITERATIONS) {
  const salt = bytesToHex(randomBytes(16));
  const hash = await pbkdf2Hex(password, salt, iterations);
  return { hash, salt, iterations };
}

export async function verifyPassword(password, user) {
  const hash = await pbkdf2Hex(password, user.password_salt, Number(user.password_iterations));
  return timingSafeEqual(hash, user.password_hash);
}

// Compares two strings in time that does not depend on where they differ.
export function timingSafeEqual(a, b) {
  const x = encoder.encode(String(a));
  const y = encoder.encode(String(b));
  let diff = x.length ^ y.length;
  const length = Math.max(x.length, y.length);
  for (let i = 0; i < length; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

export function newSessionToken() {
  return bytesToBase64Url(randomBytes(32));
}

// Temporary passwords: 16 characters from an alphabet without look-alikes
// (no 0/O, 1/l/I), grouped in fours so they are easy to read out.
const TEMP_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function temporaryPassword() {
  const chars = [];
  // Rejection sampling keeps every character equally likely.
  while (chars.length < 16) {
    for (const byte of randomBytes(32)) {
      if (byte < 220 && chars.length < 16) chars.push(TEMP_ALPHABET[byte % 55]);
    }
  }
  return chars.join("").match(/.{4}/g).join("-");
}

export function checkPasswordStrength(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Passwords need at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 200) return "Passwords can have at most 200 characters.";
  return null;
}
