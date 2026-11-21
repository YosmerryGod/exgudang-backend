import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { db } from './database.js';

const issuer = 'exgudang-backend';
const audience = 'exgudang-frontend';

export function getJwtSecret() {
  const secret = process.env.JWT_SECRET || '';
  if (secret.length < 32) throw new Error('JWT_SECRET wajib diisi dengan minimal 32 karakter.');
  return secret;
}

export function createSession(admin) {
  const jti = randomUUID();
  const token = jwt.sign(
    { username: admin.username },
    getJwtSecret(),
    {
      subject: String(admin.id),
      jwtid: jti,
      issuer,
      audience,
      expiresIn: process.env.JWT_EXPIRES_IN || '7d'
    }
  );
  const decoded = jwt.decode(token);
  db.prepare('INSERT INTO auth_sessions (jti, admin_id, expires_at) VALUES (?, ?, ?)').run(
    jti, admin.id, Number(decoded.exp)
  );
  return token;
}

export function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ success: false, message: 'Sesi tidak ditemukan. Silakan login.' });
  }

  try {
    const payload = jwt.verify(match[1], getJwtSecret(), { issuer, audience });
    const session = db.prepare(`
      SELECT s.jti, a.id, a.username
      FROM auth_sessions s
      JOIN admins a ON a.id = s.admin_id
      WHERE s.jti = ?
        AND s.admin_id = ?
        AND s.revoked_at IS NULL
        AND s.expires_at > ?
        AND a.is_active = 1
    `).get(payload.jti, Number(payload.sub), Math.floor(Date.now() / 1000));

    if (!session) {
      return res.status(401).json({ success: false, message: 'Sesi sudah berakhir. Silakan login kembali.' });
    }
    req.admin = { id: session.id, username: session.username };
    req.sessionId = session.jti;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Token tidak valid atau sudah kedaluwarsa.' });
  }
}

export function revokeSession(jti) {
  db.prepare(`
    UPDATE auth_sessions
    SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE jti = ? AND revoked_at IS NULL
  `).run(jti);
}
