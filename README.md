# Tracker Hutang (Pilihan A)

Repo ini menggabungkan:
- Frontend (GitHub Pages): `index.html`, `database.js`
- Backend (Firebase Cloud Functions): folder `functions/`

## Setup ringkas

1) Pasang Firebase CLI & login:
```bash
npm install -g firebase-tools
firebase login
```

2) Install deps functions:
```bash
cd functions
npm install
cd ..
```

3) Buat env:
- Salin `functions/.env.example` -> `functions/.env`
- Masukkan secret ToyyibPay anda.

4) Deploy functions:
```bash
firebase deploy --only functions
```

5) GitHub Pages:
- Push repo ini ke GitHub
- Enable Pages untuk branch `main` (root)

## Nota
Login penghutang menggunakan "password sahaja" sesuai untuk skala kecil.
Untuk security lebih tinggi, naik taraf kepada Firebase Auth.
