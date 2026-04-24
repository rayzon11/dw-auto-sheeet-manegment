# B2C DW Hisab

Multi-user web app + Chrome extension + bank/GPay statement parsers for daily D/W book-keeping.

## Quick start (localhost)

```
cd b2c_hisab
npm install
npm start
```

Open http://localhost:3000 and log in with the bootstrap admin:
- username: `admin`
- password: `admin123`

**Change this password immediately** (Change password button in header) or set `ADMIN_USER` / `ADMIN_PASS` env vars before first run.

## Chrome extension

1. Open `chrome://extensions`, enable Developer mode, click **Load unpacked**, select `b2c_hisab/extension/`.
2. In the web app, go to **Admin → API tokens** and generate a token.
3. Open the extension's **Settings** (Options page), paste `http://localhost:3000` and the token, save.
4. Open `panel.freeplay24.com` / `admin.testawl247.com`, log in there, browse to the deposit/withdrawal report page. The extension auto-scrapes and pushes to our server. Click the extension icon → "Sync this tab" to force a sync.

## Business date

Entries are bucketed by a business date that rolls over at **05:30 IST**. A transaction recorded at 04:00 IST goes into the previous calendar day's book; one at 05:35 IST goes into the new day's book. The header date picker defaults to the current business date; change it to view older books.

## Railway deployment (later)

- Set env vars: `ADMIN_USER`, `ADMIN_PASS`, `DB_PATH=/data/hisab.db`, attach a volume to `/data`.
- Point the Chrome extension's Server URL to the Railway https URL.
