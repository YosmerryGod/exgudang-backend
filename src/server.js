import 'dotenv/config';
import app from './app.js';
import { db, databaseInfo, closeDatabase } from './database.js';
import { getJwtSecret } from './auth.js';
import bcrypt from 'bcryptjs';

const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || '0.0.0.0';

function bootstrapAdmin() {
  const existing = Number(db.prepare('SELECT COUNT(*) AS total FROM admins').get().total);
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;

  if (existing > 0) return;
  if (!username || !password) {
    throw new Error('Database belum memiliki admin. Isi ADMIN_USERNAME dan ADMIN_PASSWORD untuk membuat admin pertama.');
  }
  if (username.trim().length < 3 || username.trim().length > 64) {
    throw new Error('ADMIN_USERNAME harus terdiri dari 3 sampai 64 karakter.');
  }
  if (password.length < 10) throw new Error('ADMIN_PASSWORD minimal 10 karakter.');

  const passwordHash = bcrypt.hashSync(password, 12);
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username.trim(), passwordHash);
  console.log('[BOOTSTRAP] Admin awal berhasil dibuat: ' + username.trim());
}

getJwtSecret();
bootstrapAdmin();

const server = app.listen(port, host, () => {
  console.log('[SERVER] ExGudang API berjalan di http://' + host + ':' + port);
  console.log('[DATABASE] SQLite: ' + databaseInfo.path);
  console.log('[DATABASE] Schema version: ' + databaseInfo.version);
});

function shutdown(signal) {
  console.log('[SERVER] Menerima ' + signal + ', menutup server...');
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
