# ExGudang Backend

REST API untuk aplikasi ExGudang. Backend menggunakan Node.js, Express, SQLite lokal, JWT, dan bcrypt.

## Arsitektur

- Frontend: repository exgudang-frontend.
- Backend: repository ini.
- Database: satu file SQLite pada disk lokal server.
- API prefix: /api.
- Health check: /health.
- Tidak menggunakan Turso, libSQL cloud, atau koneksi database dari browser.

## Persyaratan

- Node.js 20 atau lebih baru.
- npm.
- Disk lokal persisten untuk file SQLite.

## Instalasi lokal

1. Clone repository dan masuk ke direktori backend.
2. Jalankan npm install.
3. Salin .env.example menjadi .env.
4. Isi JWT_SECRET dengan string acak minimal 32 karakter.
5. Isi ADMIN_USERNAME dan ADMIN_PASSWORD untuk membuat admin pertama.
6. Jalankan npm run dev.
7. Server berjalan pada port 4000 secara default.

## Environment variables

| Variable | Keterangan |
|---|---|
| NODE_ENV | development atau production |
| HOST | Alamat bind server, default 0.0.0.0 |
| PORT | Port HTTP, default 4000 |
| DB_PATH | Lokasi file SQLite; gunakan path persisten |
| JWT_SECRET | Secret JWT minimal 32 karakter |
| JWT_EXPIRES_IN | Masa berlaku token, default 7d |
| ADMIN_USERNAME | Username admin pertama saat database masih kosong |
| ADMIN_PASSWORD | Password admin pertama, minimal 10 karakter |
| CORS_ORIGIN | Origin frontend yang diizinkan, dipisahkan koma; * mengizinkan semua origin |

Admin awal hanya dibuat jika tabel admins masih kosong. Mengubah ADMIN_PASSWORD setelah admin terbentuk tidak otomatis mengganti password yang tersimpan.

## Penyimpanan SQLite dan deployment

Jangan menaruh database produksi di direktori source yang akan diganti saat deploy. Buat direktori data terpisah, misalnya:

    sudo mkdir -p /var/lib/exgudang
    sudo chown -R $USER:$USER /var/lib/exgudang

Atur DB_PATH=/var/lib/exgudang/exgudang.sqlite.

SQLite menggunakan WAL mode, foreign key, dan busy timeout. Jalankan satu instance backend pada satu mesin dengan disk lokal persisten. Jangan berbagi satu file SQLite melalui NFS/SMB atau antar beberapa server backend.

Karena database berupa file lokal, deployment backend disarankan pada VPS atau hosting yang menyediakan persistent disk. Jangan mengandalkan filesystem sementara serverless untuk menyimpan database produksi. Frontend boleh tetap berada di Vercel; arahkan VITE_API_URL ke URL backend, misalnya https://api.domain-kamu.com/api.

## Menjalankan dengan PM2

    npm install
    npm run start

Contoh PM2:

    pm2 start npm --name exgudang-backend -- start
    pm2 save
    pm2 startup

Pastikan file .env dan direktori DB_PATH tersedia untuk user proses backend.

## Membuat backup

Gunakan SQLite online backup, bukan menyalin file database aktif secara langsung saat WAL sedang digunakan.

Contoh dengan sqlite3:

    sqlite3 /var/lib/exgudang/exgudang.sqlite ".backup '/var/lib/exgudang/backups/exgudang-backup.sqlite'"

Simpan backup di lokasi terpisah dari server utama dan uji proses restore secara berkala. File database, -wal, dan -shm tidak boleh masuk Git.

## API

Semua endpoint selain login dan health memerlukan header Authorization: Bearer <token>.

| Method | Endpoint | Fungsi |
|---|---|---|
| GET | /health | Status server dan SQLite |
| POST | /api/auth/login | Login admin |
| POST | /api/auth/logout | Revoke sesi aktif |
| GET | /api/auth/me | Profil admin aktif |
| GET | /api/dashboard | Ringkasan dashboard |
| GET / POST | /api/categories | Daftar / tambah kategori |
| PATCH / DELETE | /api/categories/:id | Ubah / hapus kategori |
| GET / POST | /api/items | Daftar / tambah barang |
| GET / PATCH / DELETE | /api/items/:id | Detail / ubah / nonaktifkan barang |
| POST | /api/items/:id/stock-in | Stok masuk |
| POST | /api/items/:id/stock-out | Stok keluar |
| GET | /api/items/:id/movements | Riwayat pergerakan barang |
| GET | /api/reports/summary | Ringkasan nilai dan jumlah stok |
| GET | /api/reports/low-stock | Daftar stok menipis atau habis |
| GET | /api/reports/movements | Ringkasan transaksi berdasarkan periode |
| GET | /api/movements/recent | Transaksi terbaru |

### Login

Request:

    POST /api/auth/login
    Content-Type: application/json

    { "username": "admin", "password": "password-yang-dikonfigurasi" }

Response:

    {
      "success": true,
      "data": {
        "token": "JWT_TOKEN",
        "admin": { "id": 1, "username": "admin" }
      }
    }

### Format respons

Sukses:

    { "success": true, "data": {} }

Gagal:

    { "success": false, "message": "Pesan kesalahan" }

## Data dan transaksi

- Kode barang dibuat otomatis dengan format BRG-001 jika tidak diberikan.
- Barang yang dihapus dinonaktifkan; riwayat transaksi tetap disimpan.
- Hapus kategori akan mengosongkan category_id barang terkait.
- Stok masuk dan keluar diproses dalam transaksi SQLite.
- Stok keluar ditolak jika jumlah melebihi stok yang tersedia.
- Setiap transaksi menyimpan kuantitas, harga modal, harga keluar, nilai transaksi, catatan, pihak terkait, dan waktu kejadian.
- Estimasi keuntungan dihitung dari nilai keluar dikurangi modal barang keluar. Biaya operasional belum dihitung.

## Keamanan

- Password disimpan sebagai bcrypt hash, bukan teks biasa.
- JWT ditandatangani dengan secret server dan sesi disimpan agar logout dapat mencabut token.
- Endpoint data memerlukan autentikasi.
- Login dibatasi maksimal 10 percobaan per 15 menit per alamat IP.
- Input divalidasi di server dan query menggunakan prepared statements.
- CORS dapat dibatasi melalui CORS_ORIGIN.
- Jangan commit .env, secret, atau file database.

## Integrasi frontend

Pada deployment frontend, set:

    VITE_API_URL=https://api.domain-kamu.com/api

Nilai tersebut harus menunjuk ke backend ini. Tambahkan domain frontend yang sebenarnya ke CORS_ORIGIN backend. Kontrak endpoint diselaraskan dengan repository exgudang-frontend.
