/* Magic-link auth — passwordless email tokens, session cookies. */
import crypto from 'node:crypto';
import { db } from './db.js';
import { sendEmail, wrap } from './email.js';

const MAGIC_TTL_MS   = 15 * 60 * 1000;             // 15 min
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function getOrCreateUser(email) {
  const e = String(email).trim().toLowerCase();
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(e);
  if (!user) {
    db.prepare('INSERT INTO users (email) VALUES (?)').run(e);
    user = db.prepare('SELECT * FROM users WHERE email = ?').get(e);
  }
  return user;
}

export async function requestMagicLink(email, publicUrl) {
  const user = getOrCreateUser(email);
  // Invalidate prior unused tokens for this user.
  db.prepare('UPDATE magic_tokens SET used = 1 WHERE user_id = ? AND used = 0').run(user.id);
  const token = randomToken();
  const expires = Date.now() + MAGIC_TTL_MS;
  db.prepare('INSERT INTO magic_tokens (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, user.id, expires);
  const link = `${publicUrl}/api/auth/verify?token=${encodeURIComponent(token)}`;
  await sendEmail({
    to: user.email,
    subject: 'Your Nova Nation Exchange sign-in link',
    html: wrap(`
      <h2 style="font-size:22px;margin:0 0 10px 0;font-weight:600;letter-spacing:-0.01em">Sign in</h2>
      <p style="font-size:15px;line-height:1.6;color:#0F1F47">Tap the button below to sign in. This link expires in 15 minutes.</p>
      <p style="margin:24px 0"><a href="${link}" style="display:inline-block;background:#0F1F47;color:#FBF8F1;padding:14px 22px;border-radius:10px;font-weight:600;text-decoration:none">Sign in to Nova Nation Exchange</a></p>
      <p style="font-size:12px;color:#5C6478">Didn't request this? Ignore the email. Nothing happens until you click the link.</p>
    `),
    text: `Sign in: ${link}\n(Expires in 15 minutes.)`,
  });
}

export function verifyMagicToken(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM magic_tokens WHERE token = ?').get(token);
  if (!row || row.used || row.expires_at < Date.now()) return null;
  db.prepare('UPDATE magic_tokens SET used = 1 WHERE token = ?').run(token);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
}

export function createSession(userId) {
  const token = randomToken();
  const expires = Date.now() + SESSION_TTL_MS;
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, expires);
  // Periodic cleanup of expired sessions.
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  return { token, expires };
}

export function sessionFromCookie(token) {
  if (!token) return null;
  return db.prepare(`
    SELECT users.* FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token = ? AND sessions.expires_at > ?
  `).get(token, Date.now()) || null;
}

export function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function attachUser(req, _res, next) {
  req.user = sessionFromCookie(req.cookies?.nne_session);
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'sign_in_required' });
  next();
}
