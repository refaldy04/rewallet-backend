# Migrasi wallet dan Xendit

Target: tabel aplikasi `public.users`, `public.profile`, `public.transaction`, dan
`public.transaction_type` dalam `schema.sql` di root. PostgreSQL 17 atau lebih baru.
Tidak ada perubahan pada schema internal Supabase (`auth`, `storage`, `realtime`, dll.).

## Urutan menjalankan

1. Buat backup dan uji salinannya terlebih dahulu.
2. Jalankan **001_wallet_preflight.sql**. Semua `issue_count` harus nol.
3. Hentikan sementara penulisan aplikasi, lalu jalankan seluruh isi
   **002_prepare_xendit_wallet.sql** sebagai pemilik database. Pada Supabase,
   gunakan SQL Editor. Jangan hanya mengeksekusi potongan file.
4. **Berhenti di tahap 002 untuk backend repo saat ini.** Tabel wallet/payment
   sengaja masih kosong. Implementasikan dan uji backend wallet/Xendit pada
   database pengujian sebelum tahap berikutnya. Tetap nonaktifkan top up/transfer:
   controller lama belum atomic, sehingga kegagalan constraint saldo dapat terjadi
   setelah operasi lain terlanjur berhasil. Jangan menjalankan aktivitas keuangan
   dengan backend lama setelah perubahan schema ini.
5. Saat backend baru siap, hentikan seluruh penulisan aplikasi, jalankan
   **003_wallet_cutover.sql**, cocokkan saldo dan ledger, lalu jalankan backend baru.

Alternatif lewat `psql` (connection string disimpan pada variabel environment,
bukan ditulis ke repository):

```powershell
psql --dbname "$env:DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/001_wallet_preflight.sql
psql --dbname "$env:DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/002_prepare_xendit_wallet.sql
# Hanya setelah backend baru siap dan seluruh penulisan aplikasi dihentikan:
psql --dbname "$env:DATABASE_URL" -X -v ON_ERROR_STOP=1 -f migrations/003_wallet_cutover.sql
```

Setiap migration perubahan mempunyai `BEGIN`/`COMMIT`, pemeriksaan data, pencatatan
versi, dan penguncian. Error membatalkan perubahan pada transaksi itu. Jika SQL
Editor meninggalkan transaksi dalam status error, jalankan `ROLLBACK` sebelum
mencoba lagi. Migration yang telah berhasil dijalankan akan ditolak jika diulang,
agar saldo pembukaan tidak diimpor dua kali. Jangan gunakan `--single-transaction`
karena file sudah mempunyai batas transaksi sendiri.

## Jika preflight melaporkan masalah

Jangan hapus baris transaksi atau membulatkan nominal untuk meloloskan migration.
Rekonsiliasi duplikasi ID/profil, relasi yang tidak valid, saldo negatif/NULL, dan
nominal pecahan berdasarkan sumber datanya. Migration tidak menganggap saldo NULL
sebagai nol. Keputusan bahwa saldo tertentu seharusnya nol harus ditinjau dahulu.
Nominal pada rancangan ini adalah **rupiah utuh**, dengan currency `IDR` saja.

User tanpa profil tidak menghalangi 002, tetapi harus mempunyai profil dan saldo
yang telah diperiksa sebelum 003. Tidak ada pengisian nominal atau relasi rekaan.

## Perubahan tahap 002

- Menambahkan primary key, foreign key dengan `ON DELETE RESTRICT`, dan satu profil
  per user. Saldo profil tetap bertipe `money` selama transisi, tetapi sekarang
  wajib ada, tidak negatif, berupa rupiah utuh, dan mempunyai default nol.
- Mengubah `transaction.amount` dari `money` menjadi `BIGINT` setelah validasi
  nominal utuh. Respons API nominal dapat berubah format; sesuaikan konsumen API.
- Menambahkan status bisnis, currency, referensi UUID, idempotency key, fingerprint
  permintaan, dan waktu baru pada transaksi. Status historis adalah `LEGACY`,
  bukan klaim bahwa pembayaran lama telah diverifikasi oleh Xendit.
- Menambahkan kode tipe. Tipe lama tetap memiliki ID lama dan diberi `LEGACY_<id>`;
  tipe `TOPUP`, `TRANSFER`, dan `OPENING_BALANCE` dibuat sebagai baris baru.
  Backend baru harus mencari ID berdasarkan kode, bukan menebak ID numerik.
- Menambahkan `wallets`, ledger `wallet_entries` yang tidak dapat diedit/dihapus,
  `payment_requests` untuk flow Xendit **PAY satu pembayaran**, dan inbox
  `payment_webhook_events`. Flow reusable/multi-capture memerlukan rancangan lain.
- Menambahkan `pin_hash` dan state pembatasan PIN. PIN lama tidak otomatis di-hash,
  disalin ke hash, atau dihapus. Backend harus melakukan hash bcrypt/reset PIN dan
  berhenti mengirim/log PIN sebelum penggunaan produksi.

`transaction.time` lama dipertahankan. `created_at` pada baris lama sengaja NULL
karena schema lama tidak menyimpan timezone; migration tidak menebak timezone.
Baris baru mendapatkan waktu `TIMESTAMPTZ`. Jangan hapus `time` sebelum timezone
historis diketahui dan seluruh pembaca histori telah diperbarui.

## Perubahan tahap 003 dan syarat backend baru

003 menyalin **saldo saat cutover** ke `wallets` dan mencatat kredit pembukaan untuk
saldo positif. Saldo nol tetap mendapat wallet tanpa entri nominal nol. Histori
lama tidak diputar ulang, karena akan menggandakan saldo. Snapshot saldo lama
tidak membuktikan bahwa top up historis pernah benar-benar dibayar ke Xendit.

003 hanya menerima tabel wallet/payment yang masih kosong dan belum ada transaksi
wallet baru. Setelah berhasil, perubahan `profile.balance`/`profile.user_id`,
penulisan transaksi legacy, dan perubahan histori legacy akan ditolak.
Kolom lama dipertahankan untuk penelusuran; backend lama tidak boleh digunakan
untuk aktivitas keuangan setelah cutover. Jangan hanya mengganti tampilan saldo.

Backend baru harus:

- Membaca saldo dari `wallets`, membuat wallet untuk user baru, dan berhenti
  menggunakan `profile.balance` sebagai saldo aktif.
- Menulis transaksi, debit/kredit wallet, dan ledger dalam **satu transaksi pada
  koneksi PostgreSQL yang sama**, dengan penguncian dan pemeriksaan dana.
- Memakai kode tipe canonical dan status eksplisit. `TRANSFER` memerlukan pengirim
  dan penerima berbeda, idempotency key, serta fingerprint SHA-256 hex lowercase
  dari payload bisnis yang telah dinormalisasi. Key yang sama dengan fingerprint
  berbeda harus ditolak; UNIQUE saja tidak cukup untuk perilaku retry yang benar.
- Mencocokkan pemilik, nominal, currency, dan identitas pembayaran; memverifikasi
  `x-callback-token` sebelum menerima webhook; lalu mengkreditkan pembayaran sekali
  saja. Simpan ID capture dan bentuk `dedup_key` dari jenis event serta identitas
  payment/capture. Jangan menganggap payload mempunyai `event_id`.
- Menyimpan inbox webhook sebelum mengakui penerimaan, dan menangani webhook yang
  datang sebelum respons create-payment, duplikat, gagal proses, dan rekonsiliasi.
- Memisahkan status permintaan pembayaran dari status transaksi saldo. Status
  `SUCCEEDED` pada `payment_requests` harus disertai ID provider/capture dan `paid_at`;
  pembuatan permintaan atau redirect sukses tidak menjadi bukti pembayaran.
- Mengamankan autentikasi, route admin, edit profil, reset password, dan verifikasi
  PIN. Migration schema tidak memperbaiki controller lama atau menjamin jumlah
  debit dan kredit seimbang; itu tanggung jawab layanan wallet dan pengujiannya.

Tabel baru mengaktifkan RLS tanpa policy untuk client, dan mencabut grant
`PUBLIC`/`anon`/`authenticated`. Aksesnya lewat koneksi backend pemilik tabel atau
role backend yang mempunyai grant dan policy yang ditinjau. JWT Express saat ini
bukan otomatis JWT Supabase. Schema ini tidak mencampur `public.users` dengan
`auth.users`. Pengamanan tabel lama tetap perlu ditangani pada backend/akses DB.

`profile.balance`, `users.pin`, dan `transaction.time` baru boleh dihapus melalui
migration lanjutan setelah semua pemakai telah berpindah dan data terverifikasi.
Tidak disediakan rollback yang menghapus ledger atau pembayaran: sebelum ada
aktivitas baru, gunakan backup teruji; setelah ada aktivitas baru, rekonsiliasi dan
buat perbaikan maju, bukan mengembalikan snapshot yang menghilangkan transaksi.

## Verifikasi saldo setelah cutover

```sql
-- Harus tidak menghasilkan baris; saat cutover, cocokkan juga dengan profile.balance.
SELECT w.user_id, w.balance,
       coalesce(sum(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END), 0) AS ledger_balance
FROM public.wallets w
LEFT JOIN public.wallet_entries e ON e.wallet_id = w.id
GROUP BY w.id
HAVING w.balance <> coalesce(sum(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END), 0);

SELECT version, applied_at FROM public.app_schema_migrations ORDER BY version;
```

## Tes lokal terisolasi

Jalankan `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-wallet-migrations.ps1`
dengan binary PostgreSQL (`initdb`, `pg_ctl`, `psql`) pada PATH. Opsi execution policy
hanya berlaku pada proses pengujian tersebut. Script membuat
cluster sementara di folder Temp pada port loopback terpisah, memakai data buatan,
dan tidak membaca `.env` maupun `DATABASE_URL`.

Referensi: [Xendit Payment Requests v3](https://docs.xendit.co/apidocs/create-payment-request),
[webhook Xendit](https://docs.xendit.co/apidocs/payment-webhook-notification),
[constraint PostgreSQL](https://www.postgresql.org/docs/17/ddl-constraints.html).
