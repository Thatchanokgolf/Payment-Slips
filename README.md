# Payment Slip Analyzer

Upload a payment slip → Claude reads the date-time, receiver, and amount → you
review, pick a category, and record it into a Neon Postgres database. A built-in
dashboard summarizes spending between any two dates.

## Stack

- **Frontend** — a single `public/index.html` page styled with Tailwind (CDN)
- **Backend** — Express server (`server.js`) for local dev; Netlify serverless
  functions (`netlify/functions/`) in production. Both share the logic in `lib/`.
- **OCR / extraction** — Claude `claude-opus-4-8` vision with structured JSON output
- **Database** — Neon serverless Postgres (`@neondatabase/serverless`)

## Project layout

```
public/              static frontend (served as-is)
lib/                 shared logic — db access, slip extraction, validation
server.js            local Express dev server  → npm start
netlify/functions/   one serverless function per API route (production)
netlify.toml         Netlify build + functions config
```

## Categories

Payments are tagged with a category number from 1–10:

| # | Category | # | Category |
|---|----------|---|----------|
| 1 | Personnel | 6 | Return deposit |
| 2 | Loans | 7 | Promotion fees |
| 3 | Electricity bills | 8 | Others |
| 4 | Water bills | 9 | Investments |
| 5 | Internet bills | 10 | Repair/Supply |

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure environment**

   ```bash
   cp .env.example .env
   ```

   Then edit `.env` and set:
   - `ANTHROPIC_API_KEY` — from <https://console.anthropic.com/>
   - `DATABASE_URL` — your Neon connection string from <https://neon.tech>

3. **Run**

   ```bash
   npm start
   ```

   The `payments` table is created automatically on first launch. Open
   <http://localhost:3000>.

## Test the production build locally (`netlify dev`)

To run the exact serverless setup locally — static site + functions + your
`.env` — instead of the Express server:

```bash
npm run dev:netlify
```

This serves everything on <http://localhost:8888>, routing `/api/*` through the
real Netlify function runtime. Useful for catching anything that behaves
differently between Express and the functions before you push.

## Deploy to Netlify

The frontend is served statically and each API route runs as a serverless
function — no always-on server needed.

1. **Connect the repo** — in Netlify, "Add new site" → "Import from Git" → pick
   this repository. `netlify.toml` already sets the publish directory (`public`)
   and functions directory, so you can leave the build settings at their defaults
   (no build command needed).

2. **Add environment variables** — Site settings → **Environment variables** →
   add the same two values from your `.env`:
   - `ANTHROPIC_API_KEY`
   - `DATABASE_URL`

3. **Deploy.** Netlify builds on every push to `main`. The routes resolve as:
   - `https://<your-site>.netlify.app/` → the form + dashboard
   - `/api/extract`, `/api/payments`, `/api/summary`, `/api/categories` → functions

> **Note:** the `payments` table is created automatically on the first request
> that touches the database, so no manual migration step is required.

## Image storage

Slip images are stored in the Neon database (table `payment_images`, created
automatically): the main slip plus up to two optional extra images per payment.
Each image is served back as a plain image response from `GET /api/image/:id`,
so the frontend shows a thumbnail next to every payment in the dashboard.

> **Note:** `/api/image/:id` is public (no auth) — anyone who knows an id can
> fetch that image. This mirrors the previous behaviour (Drive links were public
> too) and is what lets the Google Sheet render thumbnails. If you add
> authentication to the app, keep this route reachable by Google's servers or
> the sheet's `=IMAGE()` cells will stop rendering.

## Google Sheets sync (optional)

When configured, clicking **Save payment** also appends the slip to a Google
Sheet — the data plus `=IMAGE()` thumbnails that point at the app's own
`/api/image/:id` URLs. It's fully optional: leave the `GOOGLE_*` env vars unset
and the app behaves normally. The Google Sheet sync is independent of the Neon
database — it just adds the new row; it does not read the sheet's existing
contents or sync the database.

**Each save appends a row with these columns (matching the sheet header):**

`Date/Time` · `Receiver` · `Amount` · `Category` · `Notes` · `Payment slip image` · `Extra image 1` · `Extra image 2`

The image cells are `=IMAGE("…/api/image/<id>")` formulas. For the sheet to
render them, the app must be deployed at a URL Google's servers can reach — so
thumbnails appear in production, but not when running on `localhost` (Google
can't fetch a local URL). The image bytes themselves live in the database, so
the extra images are stored too (unlike before, when they went to the sheet
only).

### One-time Google setup

The target Sheet (the `ฟอร์มจ่ายเงินใหม่` tab) is already set in `lib/sheets.js`,
so you only need to supply credentials. No Google Drive folder or Drive API is
needed any more — images are served from the database.

1. **Service account** — in [Google Cloud Console](https://console.cloud.google.com/),
   create a project, then **APIs & Services → Enable APIs** and enable the
   **Google Sheets API**.
2. **IAM → Service Accounts → Create** a service account, then **Keys → Add key →
   JSON**. The downloaded file has `client_email` and `private_key`.
3. **Share the Sheet** (Editor) with that `client_email`.
4. **Set the env vars** (see `.env.example`): `GOOGLE_SERVICE_ACCOUNT_EMAIL` and
   `GOOGLE_PRIVATE_KEY` (one line, quoted, `\n` for newlines). On Netlify, add
   these under Site settings → Environment variables and redeploy. The Sheet/tab
   can be overridden with `GOOGLE_SHEET_ID` / `GOOGLE_SHEET_TAB` if they ever
   change.

## How it works

1. **Upload a slip** → click **Analyze slip**. The image is sent to
   `/api/extract`, which calls Claude vision and returns the fields to pre-fill
   the form. Nothing is saved yet — you review and correct anything.
2. **Pick a category** (1–10) and click **Save payment** → `POST /api/payments`
   inserts the row into Neon.
3. **Dashboard** → choose a date range and click **Load** → `GET /api/summary`
   returns the grand total, count, a per-category breakdown, and the matching
   payments.

You can also skip the image and enter a payment entirely by hand.

## API

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/extract` | Read a slip image (`{ image: <data URL> }`) → `{ paid_at, receiver, amount }` |
| `POST` | `/api/payments` | Save `{ paid_at, receiver, amount, category }` (+ optional `image`, `extraImages` stored in the DB) |
| `GET`  | `/api/image/:id` | Serve a stored slip image by id (public) |
| `GET`  | `/api/summary?start=YYYY-MM-DD&end=YYYY-MM-DD` | Totals + breakdown + rows (each with its image ids) for the range |
| `GET`  | `/api/categories` | The 1–10 category labels |

## Notes

- The extraction prompt instructs Claude to return `null` for any field it
  can't read confidently, rather than guessing — so always review before saving.
- The `end` date in the summary is treated as **inclusive** of the whole day.
- Image uploads are limited to 15 MB.
