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
| `POST` | `/api/payments` | Save `{ paid_at, receiver, amount, category }` |
| `GET`  | `/api/summary?start=YYYY-MM-DD&end=YYYY-MM-DD` | Totals + breakdown + rows for the range |
| `GET`  | `/api/categories` | The 1–10 category labels |

## Notes

- The extraction prompt instructs Claude to return `null` for any field it
  can't read confidently, rather than guessing — so always review before saving.
- The `end` date in the summary is treated as **inclusive** of the whole day.
- Image uploads are limited to 15 MB.
