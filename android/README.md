# B2C Hisab — Android SMS/Notification Sync

Auto-captures every bank SMS + bank-app push notification on your phone,
parses amount / credit-debit / bank charge / counterparty name / UTR, and
pushes it to the B2C Hisab server. The server classifies and routes each
entry into the right sheet cell (bank row, panel column, or Bank Charge /
ATM / Extra Payment / Salary / Parking ledger).

## Why this works for every bank

Every Indian bank sends an SMS for every credit / debit / charge. Reading
SMS + notifications covers 100% of accounts — no statement download, no
webhook, no API needed.

## Build

1. Install Android Studio (Koala or newer).
2. Open the `android/` folder as a project.
3. Let Gradle sync. Then **Build → Build APK**.
4. Install the generated `app-debug.apk` on your phone (USB, or `adb install`).

## First-run setup (on the phone)

1. Open **B2C Hisab** app.
2. Enter:
   - **Server URL:** e.g. `http://192.168.1.10:3000` (LAN) or your Railway/Vercel URL.
   - **API token:** generate in the web app → Admin → API tokens → copy.
3. Tap **Save config**.
4. Tap **Grant SMS permissions** → allow.
5. Tap **Grant Notification access** → toggle "B2C Hisab Notification Listener" ON.
6. Tap **Backfill: send last 500 SMS** — the server parses and files them.

After this, every new SMS and bank-app push fires the upload automatically.

## What gets written to the sheet

| SMS example | Server action | Sheet cell |
|---|---|---|
| `Rs.5000 credited by UPI/ALICE/…` (HDFC) | +₹5000 to HDFC bank row's **Credit** col; D/W row "ALICE" in `dw` table | Row 3 col E, plus panel column if panel mapped |
| `Rs.2500 debited to RAVI on … UTR 99887766` (ICICI) | -₹2500 to ICICI bank row's **Debit** col; D/W row "RAVI" | Row 4 col G |
| `Rs.199 SGST CHG` (any bank) | → Bank & Exp ledger as `BANK CHG` | Row 61+ cols D/E |
| `Rs.350 ATM WD` | → Bank & Exp ledger as `ATM` | Row 61+ cols D/E |

## Permissions needed

- `READ_SMS` + `RECEIVE_SMS` — for live + backfill.
- **Notification Listener access** (user grants via Settings) — for bank apps
  that don't send SMS (e.g. some wallet txns, UPI-only notifications).

No other data leaves the phone.
