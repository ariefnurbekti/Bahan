# Mengaktifkan checkout Midtrans

Checkout meminta harga produk langsung dari `store_catalog` di Supabase. Nilai harga dari browser tidak dipakai untuk membuat tagihan. Server Key Midtrans dan Supabase Service Role Key hanya disimpan sebagai secret Cloudflare Worker.

## 1. Jalankan migration Supabase

Jalankan semua migration di `supabase/migrations` secara berurutan pada project Supabase yang dipakai toko, termasuk `20261022100000_add_whatsapp_sales_outcome.sql`. Pesanan lama akan diberi status `manual`; pesanan dari checkout Midtrans akan memakai status `pending` sampai notifikasi pembayaran diterima. Migration terkait pembayaran juga menonaktifkan insert order publik agar pesanan baru hanya dibuat oleh Worker. Migration terbaru menambahkan hasil follow-up WhatsApp Close Won/Close Lost.

## 2. Deploy Worker

Pasang Wrangler lalu jalankan perintah berikut dari folder repository:

```powershell
Set-Location worker
npm install --global wrangler
wrangler login
wrangler deploy
```

Atur secrets Worker dari folder `worker` (jangan menaruh nilainya di file atau repository):

```powershell
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put MIDTRANS_SERVER_KEY
wrangler secret put STOREFRONT_ORIGIN
wrangler secret put STOREFRONT_URL
```

Tambahkan variable `MIDTRANS_ENVIRONMENT` melalui Cloudflare Worker Settings > Variables:

- `sandbox` untuk pengujian dengan Sandbox Server Key.
- `production` untuk transaksi asli dengan Production Server Key.

Isi `STOREFRONT_ORIGIN` dengan origin situs yang tepat, tanpa path, misalnya `https://ariefnurbekti.github.io`. Isi `STOREFRONT_URL` dengan halaman toko lengkap, misalnya `https://ariefnurbekti.github.io/Bahan/`. URL ini dipakai untuk CORS dan tujuan kembali setelah pembayaran.

## 3. Hubungkan halaman toko ke Worker

Setelah deploy, salin alamat Worker (misalnya `https://bahan-midtrans-api.<subdomain-akun>.workers.dev`) ke konstanta `PAYMENT_API_URL` pada `index.html`, tanpa akhiran `/`. Pastikan origin situs pada `STOREFRONT_ORIGIN` sama dengan origin halaman yang digunakan pelanggan.

## 4. Atur notifikasi Midtrans

Pada dashboard Midtrans, atur Payment Notification URL ke:

```text
https://<alamat-worker>/api/midtrans/notification
```

Gunakan alamat Worker yang sama dengan `PAYMENT_API_URL`. Worker memverifikasi `signature_key` notifikasi sebelum memperbarui status pesanan. Endpoint `/health` dapat dipakai untuk memastikan Worker aktif.

## Alur pembayaran

Worker memvalidasi item dan harga dari katalog Supabase, membuat catatan pesanan, lalu meminta Snap redirect URL dari Midtrans. Setelah pelanggan menyelesaikan pembayaran, notifikasi bertanda tangan memperbarui status pembayaran. Statusnya terlihat pada kolom **Pembayaran** di dashboard admin; halaman toko juga memeriksa status ketika pelanggan kembali dari Midtrans.

Jangan pernah menaruh Server Key Midtrans atau Service Role Key Supabase pada `index.html`, GitHub Pages, atau file konfigurasi yang masuk repository.
