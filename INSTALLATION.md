# Instalasi & Kompilasi FormForge

Panduan ini menjelaskan cara menyiapkan lingkungan pengembangan, menjalankan FormForge dari kode sumber, dan mengompilasi installer untuk **Windows**, **Linux**, dan **macOS**.

FormForge adalah aplikasi Electron. Mesin render OpenSCAD WebAssembly diunduh otomatis saat build dan disertakan di dalam installer, sehingga pengguna akhir **tidak** perlu memasang OpenSCAD, Node.js, atau dependensi lain.

---

## 1. Ringkasan cepat

| Tujuan | Perintah | Hasil |
|---|---|---|
| Pasang dependensi | `npm ci` | folder `node_modules/` |
| Jalankan dari sumber | `npm start` | aplikasi terbuka (mode pengembangan) |
| Uji + cek sintaks + build | `npm run check` | semua tes lulus, `dist/renderer.js` |
| Installer Windows | `npm run dist:win` | `release/FormForge-<versi>-win-x64.exe` |
| Installer macOS | `npm run dist:mac` | `release/FormForge-<versi>-mac-x64.dmg` dan `-mac-arm64.dmg` |
| Paket Linux | `npm run dist:linux` | `release/FormForge-<versi>-linux-x86_64.AppImage` |
| Paket tanpa installer | `npm run package` | `release/<os>-unpacked/` |

> **Aturan penting:** kompilasi installer di sistem operasi yang dituju. DMG macOS **hanya** bisa dibuat di macOS. Installer Windows sebaiknya dibuat di Windows, dan AppImage di Linux.

---

## 2. Persyaratan umum (semua OS)

- **Node.js 22.12 atau lebih baru** (lihat `engines` di `package.json`). Ini **wajib**: pengunduh biner Electron 45 memakai modul ES yang tidak bisa dimuat Node lama (galat `ERR_REQUIRE_ESM`). Disarankan versi LTS terbaru. npm ikut terpasang bersama Node.js.
- **Koneksi internet** saat build pertama: biner Electron diunduh saat `electron` pertama kali dijalankan (bukan saat `npm ci`), dan OpenSCAD WebAssembly diunduh dari `files.openscad.org`.

Sistem operasi yang didukung (mengikuti Electron 45):

| OS | Minimum |
|---|---|
| Windows | 10 atau 11, **64-bit** (x64). Windows 32-bit tidak didukung lagi. |
| macOS | **13 Ventura** atau lebih baru (Intel dan Apple silicon). |
| Linux | x64; distro modern (mis. Ubuntu 22.04+, Debian 12+, Fedora 40+). |
- **Ruang disk** ± 1,5 GB (`node_modules` + cache Electron + hasil build).
- Git (opsional, bila kode diambil dari repositori).

Tidak ada modul native yang perlu dikompilasi, jadi Visual Studio Build Tools, Xcode penuh, atau `build-essential` **tidak** diperlukan.

Cek versi:

```bash
node --version   # harus v22.12.0 atau lebih baru
npm --version
```

---

## 3. Windows (10/11, x64)

### 3.1 Siapkan lingkungan

1. Pasang Node.js LTS dari <https://nodejs.org> (installer `.msi`), atau lewat winget:

   ```powershell
   winget install OpenJS.NodeJS.LTS
   ```

2. Tutup lalu buka kembali PowerShell agar `node` dan `npm` dikenali.

### 3.2 Jalankan dari sumber

Buka PowerShell di folder proyek:

```powershell
npm ci
npm start
```

`npm start` menjalankan build (mengunduh + memverifikasi OpenSCAD WASM ke `vendor/openscad-wasm/`, lalu membundel `renderer.js` ke `dist/renderer.js`) kemudian membuka aplikasi.

### 3.3 Kompilasi installer

```powershell
npm ci
npm run check      # opsional tetapi disarankan: cek sintaks + tes + build
npm run dist:win
```

Hasil: `release\FormForge-0.1.0-win-x64.exe` (installer NSIS; pengguna dapat memilih folder instalasi).

Catatan:
- Installer **belum ditandatangani** (code signing). Windows SmartScreen dapat menampilkan peringatan "Windows protected your PC" → klik **More info › Run anyway**. Untuk distribusi publik, tandatangani dengan sertifikat code signing (atur variabel lingkungan `CSC_LINK` dan `CSC_KEY_PASSWORD` sebelum `npm run dist:win`).
- Bila PowerShell menolak menjalankan `npm` karena *execution policy*, jalankan sekali: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

---

## 4. Linux (x64)

### 4.1 Siapkan lingkungan

Pasang Node.js 22+ — jangan memakai paket `nodejs` bawaan distro bila versinya lebih lama. Pilihan termudah adalah [nvm](https://github.com/nvm-sh/nvm):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
# buka terminal baru, lalu:
nvm install --lts
nvm use --lts
```

Pustaka sistem yang dibutuhkan Electron (untuk menjalankan aplikasi dan AppImage):

**Debian / Ubuntu**

```bash
sudo apt update
sudo apt install -y libnss3 libgtk-3-0 libxss1 libgbm1 libasound2 libfuse2
# Ubuntu 24.04+: ganti libasound2 → libasound2t64 dan libfuse2 → libfuse2t64
```

**Fedora**

```bash
sudo dnf install -y nss gtk3 libXScrnSaver mesa-libgbm alsa-lib fuse-libs
```

**Arch**

```bash
sudo pacman -S --needed nss gtk3 libxss mesa alsa-lib fuse2
```

### 4.2 Jalankan dari sumber

```bash
npm ci
npm start
```

### 4.3 Kompilasi AppImage

```bash
npm ci
npm run check      # opsional tetapi disarankan
npm run dist:linux
```

Hasil: `release/FormForge-0.1.0-linux-x86_64.AppImage`.

Menjalankan AppImage:

```bash
chmod +x release/FormForge-*.AppImage
./release/FormForge-*.AppImage
```

Bila muncul galat FUSE (`dlopen(): error loading libfuse.so.2`), pasang `libfuse2`/`libfuse2t64` seperti di atas, atau jalankan tanpa FUSE:

```bash
./release/FormForge-*.AppImage --appimage-extract-and-run
```

---

## 5. macOS (Intel & Apple silicon)

### 5.1 Siapkan lingkungan

1. Pasang Command Line Tools (berisi git dan utilitas dasar):

   ```bash
   xcode-select --install
   ```

2. Pasang Node.js 22+ dari <https://nodejs.org> (installer `.pkg`), lewat Homebrew, atau nvm:

   ```bash
   brew install node@22
   # atau: nvm install --lts
   ```

### 5.2 Jalankan dari sumber

```bash
npm ci
npm start
```

### 5.3 Kompilasi DMG

```bash
npm ci
npm run check      # opsional tetapi disarankan
npm run dist:mac
```

Hasil di `release/`:
- `FormForge-0.1.0-mac-x64.dmg` — Mac Intel
- `FormForge-0.1.0-mac-arm64.dmg` — Mac Apple silicon (M1/M2/M3/…)

Catatan:
- Aplikasi **belum ditandatangani & dinotarisasi**. Gatekeeper akan memblokirnya saat pertama dibuka. Untuk pengujian: klik kanan aplikasi › **Open**, atau jalankan:

  ```bash
  xattr -dr com.apple.quarantine /Applications/FormForge.app
  ```

- Untuk distribusi publik dibutuhkan akun Apple Developer: sertifikat *Developer ID Application* (via `CSC_LINK`/`CSC_KEY_PASSWORD` atau keychain) dan notarisasi (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, serta opsi `"notarize": true` di bagian `build.mac` `package.json`). Konfigurasi ini belum disertakan.

---

## 6. Apa yang terjadi saat build

1. `scripts/fetch-openscad-wasm.cjs` mengunduh `OpenSCAD-<versi>-WebAssembly-web.zip` dari `https://files.openscad.org/snapshots/`, memverifikasi checksum SHA-256, lalu mengekstraknya ke `vendor/openscad-wasm/`. Langkah ini dilewati bila mesin sudah ada.
2. `esbuild` membundel `renderer.js` (beserta Three.js) menjadi `dist/renderer.js`.
3. `electron-builder` mengemas aplikasi ke `release/`. Folder `vendor/openscad-wasm` disalin ke `resources/openscad-wasm` di dalam paket. File pengembangan (`test/`, `scripts/`, `imple/`, `reffImage/`, `.claude/`, dokumen `.md`) tidak ikut dikemas.

Folder `dist/`, `release/`, `node_modules/`, dan `vendor/openscad-wasm/` adalah hasil build — aman dihapus kapan saja dan akan dibuat ulang.

---

## 7. Lokasi data pengguna

Pustaka tool, preset, pengaturan, dan icon pack disimpan di direktori data Electron:

| OS | Aplikasi terpasang | Mode pengembangan (`npm start`) |
|---|---|---|
| Windows | `%APPDATA%\FormForge` | `%APPDATA%\formforge` |
| macOS | `~/Library/Application Support/FormForge` | `~/Library/Application Support/formforge` |
| Linux | `~/.config/FormForge` | `~/.config/formforge` |

Menghapus aplikasi tidak menghapus folder ini; hapus manual bila ingin bersih total.

---

## 8. Pemecahan masalah

| Gejala | Penyebab & solusi |
|---|---|
| `npm WARN EBADENGINE`, `ERR_REQUIRE_ESM` dari `node_modules/electron/install.js`, atau "Electron failed to install correctly" | Versi Node < 22.12. Perbarui Node.js, hapus `node_modules/electron`, lalu jalankan `npm ci` dan `npm start` lagi (atau `npx install-electron --no`). |
| `Could not prepare OpenSCAD WASM: Download failed (404)` | Server snapshot OpenSCAD menghapus snapshot lama. Buka <https://files.openscad.org/snapshots/>, cari file `OpenSCAD-YYYY.MM.DD-WebAssembly-web.zip` terbaru, ganti konstanta `VERSION` di `scripts/fetch-openscad-wasm.cjs`, hapus `vendor/openscad-wasm/`, lalu build ulang dan uji render. **Simpan salinan folder `vendor/openscad-wasm/` yang sudah berfungsi** agar build tidak bergantung pada server snapshot. |
| `OpenSCAD WASM checksum verification failed` | Unduhan rusak/terpotong atau diintersep proxy. Ulangi build; periksa koneksi/proxy. |
| Unduhan Electron gagal / lambat (saat `npm start` pertama atau `npm run dist:*`) | Jaringan atau proxy perusahaan. Atur `HTTPS_PROXY`, atau mirror: `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`. `ELECTRON_SKIP_BINARY_DOWNLOAD` tidak berlaku lagi sejak Electron 42. |
| "Render engine missing" di aplikasi | `vendor/openscad-wasm/` kosong saat packaging. Jalankan `npm run build` dengan koneksi internet lalu kemas ulang. |
| Linux: aplikasi tidak terbuka, galat `libnss3.so`/`libgtk-3.so` | Pasang pustaka sistem di bagian 4.1. |
| macOS: "FormForge is damaged and can't be opened" | Atribut karantina pada aplikasi tanpa tanda tangan. Jalankan perintah `xattr` di bagian 5.3. |
| Windows: SmartScreen memblokir installer | Installer belum ditandatangani. **More info › Run anyway**, atau tandatangani installer. |

---

## 9. Pemeliharaan keamanan

- Jalankan `npm audit` secara berkala. Electron adalah *runtime* aplikasi (walau tercantum di `devDependencies`), jadi pembaruan keamanannya langsung memengaruhi pengguna. Perbarui ke rilis Electron yang masih didukung, lalu jalankan `npm run check` dan uji render/ekspor sebelum merilis.
- Gunakan `npm ci` (bukan `npm install`) untuk build rilis agar versi dependensi sesuai `package-lock.json`.
