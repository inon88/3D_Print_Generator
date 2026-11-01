# FormForge

FormForge adalah aplikasi desktop lokal untuk mengubah parameter tool OpenSCAD dan melihat pratinjau model.

The application interface is available in English.

## Run locally

Persyaratan:

- Node.js 22.12 atau lebih baru (dibutuhkan Electron yang telah menerima pembaruan keamanan)
- Koneksi internet saat membangun aplikasi untuk mengunduh OpenSCAD WebAssembly resmi (installer hasil build sudah menyertakan mesin render)

```powershell
npm install
npm start
```

Saat pertama dijalankan, FormForge menambahkan contoh bracket ke pustaka lokal. Saat `npm start` atau proses packaging pertama kali dijalankan, build mengunduh dan memverifikasi OpenSCAD WebAssembly. Pengguna installer tidak perlu memasang OpenSCAD atau CLI tambahan.

## Build aplikasi desktop

Panduan lengkap (persyaratan per OS, pustaka Linux, code signing, pemecahan masalah) ada di [INSTALLATION.md](INSTALLATION.md).

Untuk membuat aplikasi siap pasang, gunakan Node.js 22.12 atau lebih baru dan npm. Jalankan build pada sistem operasi yang ingin dituju; khususnya, file DMG macOS harus dibuat di macOS. Perintah berikut membangun renderer lalu mengemas aplikasi menggunakan Electron Builder.

### Windows

Di Windows x64, buka PowerShell di folder proyek:

```powershell
npm ci
npm run dist:win
```

Installer NSIS akan dibuat di folder `release`. Installer ini memungkinkan pengguna memilih lokasi pemasangan. Aplikasi belum ditandatangani; Windows mungkin menampilkan peringatan SmartScreen.

### macOS

Di Mac, buka Terminal di folder proyek:

```bash
npm ci
npm run dist:mac
```

Perintah ini membuat file DMG untuk Intel (x64) dan Apple silicon (arm64) di folder `release`. Untuk distribusi di luar pengujian, aplikasi perlu ditandatangani dan dinotarisasi dengan sertifikat Apple Developer; konfigurasi tersebut belum disertakan.

### Linux

Di Linux x64, buka terminal di folder proyek:

```bash
npm ci
npm run dist:linux
```

AppImage akan dibuat di folder `release`. Menjalankannya mungkin memerlukan dukungan FUSE pada distribusi Linux pengguna.

Untuk sekadar mengemas aplikasi tanpa membuat installer, jalankan `npm run package`; hasil direktori aplikasi unpacked juga disimpan di `release`. OpenSCAD WebAssembly disertakan dalam installer. Pengguna tidak perlu memasang OpenSCAD terpisah.

## Alur kerja

1. **Add tool** (sidebar, `Ctrl+O`) — pilih sumber: **SCAD file**, **Project folder** (untuk model yang memakai `include`/`use`, gambar, SVG, atau mesh lewat `surface()`/`import()`), atau **From URL** (tautan HTTPS langsung ke `.scad`). FormForge menyimpan salinan di pustaka lokal.
2. **Parameters** (sidebar) — ubah parameter Customizer yang terdeteksi (slider, dropdown berlabel, sakelar, teks, vektor). Grup `/* [Nama] */` tampil sebagai bagian yang bisa dilipat. Simpan kombinasi nilai sebagai **preset**, muat ulang, timpa, atau hapus. **Add custom parameter** untuk variabel yang tidak terdeteksi otomatis.
3. **Preview** — pratinjau diperbarui otomatis setelah jeda singkat (atau tekan **Render preview**, `Ctrl+Enter`). Hasil terakhir tetap tampil saat render berjalan atau gagal; galat OpenSCAD lengkap bisa dibuka di panel galat. Navigasi: tombol tengah mouse = orbit, Shift + tombol tengah = pan, roda = zoom, `F` = bingkai model, `G` = grid.
4. **Export** (kanan atas, `Ctrl+E`) — STL biner (geometri) atau 3MF (geometri dengan warna). Ekspor selalu dirender ulang pada **resolusi maksimum** (`$fn=0`, `$fa=2°`, `$fs=0.2 mm`) yang menimpa `$fn`/`$fa`/`$fs` global milik file sumber; lengkung menyimpang ≤ ~0,015 mm dari bentuk ideal, lebih halus dari yang dapat dicetak printer. Bila model sangat berat (mis. `minkowski` dengan bola) melebihi 5 menit, ekspor otomatis memakai resolusi bawaan model dan memberi tahu pengguna.
5. **Slicer** — printer, material, dan seluruh setting cetak diatur di slicer pilihan Anda. FormForge tidak menyimpan profil cetak, tidak melakukan slice, dan tidak membuat G-code.

## Catatan fitur

- Parameter `font_name` menampilkan font TTF/OTF yang terpasang di perangkat beserta pratinjaunya; font terpilih disediakan ke mesin OpenSCAD saat render. Font TrueType tanpa program hinting (yang membuat mesin WASM crash) tidak ditampilkan.
- Parameter `icon_left_file`/`icon_right_file` menerima SVG/PNG/JPG/WebP; gambar raster dikonversi menjadi siluet SVG.
- Override resolusi ekspor hanya menimpa assignment tingkat atas. `$fn` yang ditulis langsung di pemanggilan (mis. `cylinder(d = 5, $fn = 6)` untuk segi enam) tetap dipakai apa adanya.
- **Settings** (`Ctrl+,`): judul aplikasi, folder & format ekspor default, pratinjau otomatis dan jedanya, serta tema (ikuti sistem/terang/gelap). Folder ekspor juga bisa diganti dengan mengklik "Export folder" di status bar.

Format ekspor hanya STL dan 3MF. STEP tidak didukung: OpenSCAD menghitung geometri sebagai mesh segitiga, bukan permukaan CAD (B-rep), sehingga tidak dapat menulis STEP; konversi mesh-ke-STEP hanya menghasilkan permukaan berfaset tanpa manfaat berarti dibanding mengimpor STL/3MF langsung ke aplikasi CAD.

Mesin render OpenSCAD WebAssembly diunduh dari server snapshot resmi saat build, checksum SHA-256 diverifikasi, lalu file mesin disertakan dalam installer.

Semua sumber pustaka dan pengaturan aplikasi disimpan dalam direktori data pengguna Electron. Impor tautan akan mengunduh salinan lokal; penghapusan tool hanya menghapus salinan milik FormForge.
