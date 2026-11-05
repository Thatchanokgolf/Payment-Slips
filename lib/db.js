import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Locally: copy .env.example to .env. On Netlify: add it under Site settings → Environment variables.");
}

// Neon's serverless driver runs each query over HTTPS — ideal for serverless
// functions. Interpolated values are sent as parameters, never concatenated,
// so this is safe against SQL injection.
export const sql = neon(process.env.DATABASE_URL);

// The 10 fixed payment categories. Index 0 is unused so the numbers line up
// with the 1-10 values the user enters.
export const CATEGORIES = [
  null,
  "Personnel",
  "Loans",
  "Electricity bills",
  "Water bills",
  "Internet bills",
  "Return deposit",
  "Promotion fees",
  "Others",
  "Investments",
  "Repair/Supply",
];

// Memoized so the schema check runs at most once per warm process (one round
// trip on a cold start, then a no-op). Both the Express server and the Netlify
// functions call this before touching the table.
let initPromise;
export function ensureDb() {
  return (initPromise ??= (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS payments (
        id          SERIAL PRIMARY KEY,
        paid_at     TIMESTAMPTZ NOT NULL,
        receiver    TEXT        NOT NULL,
        amount      NUMERIC(14, 2) NOT NULL CHECK (amount >= 0),
        category    SMALLINT    NOT NULL CHECK (category BETWEEN 1 AND 10),
        notes       TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS payments_paid_at_idx ON payments (paid_at)`;
    // Migration for databases created before the notes column existed.
    await sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS notes TEXT`;

    // Slip images, stored in the database (not Google Drive). One row per
    // image: slot 0 is the main slip, slots 1-2 are the optional extras. The
    // bytes are kept as base64 text and served out via GET /api/image/:id.
    await sql`
      CREATE TABLE IF NOT EXISTS payment_images (
        id          SERIAL PRIMARY KEY,
        payment_id  INTEGER     NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
        slot        SMALLINT    NOT NULL CHECK (slot BETWEEN 0 AND 2),
        mime_type   TEXT        NOT NULL,
        data        TEXT        NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS payment_images_payment_id_idx ON payment_images (payment_id)`;
  })());
}

// Insert one slip image (base64) linked to a payment. Returns its id + slot.
export async function insertPaymentImage({ paymentId, slot, mime, data }) {
  await ensureDb();
  const [row] = await sql`
    INSERT INTO payment_images (payment_id, slot, mime_type, data)
    VALUES (${paymentId}, ${slot}, ${mime}, ${data})
    RETURNING id, slot
  `;
  return row;
}

// Update a payment's fields by id. Returns the updated row, or null if no such
// payment exists.
export async function updatePayment({ id, when, receiver, amt, cat, notes }) {
  await ensureDb();
  const [row] = await sql`
    UPDATE payments
    SET paid_at = ${when.toISOString()}, receiver = ${receiver}, amount = ${amt},
        category = ${cat}, notes = ${notes}
    WHERE id = ${id}
    RETURNING id, paid_at, receiver, amount, category, notes
  `;
  return row || null;
}

// Delete a payment by id (its images cascade away). Returns { id } or null.
export async function deletePayment(id) {
  await ensureDb();
  const [row] = await sql`DELETE FROM payments WHERE id = ${id} RETURNING id`;
  return row || null;
}

// Fetch one image's media type + base64 bytes by id, or null if not found.
export async function getPaymentImage(id) {
  if (!Number.isInteger(id)) return null;
  await ensureDb();
  const [row] = await sql`
    SELECT mime_type, data FROM payment_images WHERE id = ${id}
  `;
  return row || null;
}

export async function insertPayment({ when, receiver, amt, cat, notes }) {
  await ensureDb();
  const [row] = await sql`
    INSERT INTO payments (paid_at, receiver, amount, category, notes)
    VALUES (${when.toISOString()}, ${receiver}, ${amt}, ${cat}, ${notes})
    RETURNING id, paid_at, receiver, amount, category, notes
  `;
  return row;
}

// Totals + per-category breakdown + matching rows for payments between two
// dates. `end` is treated as inclusive of the whole day.
export async function getSummary(start, end) {
  await ensureDb();

  const lower = `${start}T00:00:00`;
  const endExclusive = new Date(`${end}T00:00:00`);
  endExclusive.setDate(endExclusive.getDate() + 1);
  const upper = endExclusive.toISOString();

  const byCategory = await sql`
    SELECT category,
           COUNT(*)::int      AS count,
           SUM(amount)::float AS total
    FROM payments
    WHERE paid_at >= ${lower} AND paid_at < ${upper}
    GROUP BY category
    ORDER BY category
  `;

  const payments = await sql`
    SELECT id, paid_at, receiver, amount::float AS amount, category, notes
    FROM payments
    WHERE paid_at >= ${lower} AND paid_at < ${upper}
    ORDER BY paid_at ASC
  `;

  // Attach each payment's image ids (slot order) so the dashboard can show
  // thumbnails via /api/image/:id — in one round trip for the whole range.
  const ids = payments.map((p) => p.id);
  if (ids.length) {
    const imgs = await sql`
      SELECT id, payment_id, slot
      FROM payment_images
      WHERE payment_id = ANY(${ids})
      ORDER BY slot ASC
    `;
    const byPayment = new Map();
    for (const im of imgs) {
      if (!byPayment.has(im.payment_id)) byPayment.set(im.payment_id, []);
      byPayment.get(im.payment_id).push({ id: im.id, slot: im.slot });
    }
    for (const p of payments) p.images = byPayment.get(p.id) || [];
  } else {
    for (const p of payments) p.images = [];
  }

  return {
    start,
    end,
    grandTotal: byCategory.reduce((acc, r) => acc + r.total, 0),
    totalCount: byCategory.reduce((acc, r) => acc + r.count, 0),
    byCategory: byCategory.map((r) => ({
      category: r.category,
      name: CATEGORIES[r.category],
      count: r.count,
      total: r.total,
    })),
    payments,
  };
}
