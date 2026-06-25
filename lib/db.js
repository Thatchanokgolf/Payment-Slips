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
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS payments_paid_at_idx ON payments (paid_at)`;
  })());
}

export async function insertPayment({ when, receiver, amt, cat }) {
  await ensureDb();
  const [row] = await sql`
    INSERT INTO payments (paid_at, receiver, amount, category)
    VALUES (${when.toISOString()}, ${receiver}, ${amt}, ${cat})
    RETURNING id, paid_at, receiver, amount, category
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
    SELECT id, paid_at, receiver, amount::float AS amount, category
    FROM payments
    WHERE paid_at >= ${lower} AND paid_at < ${upper}
    ORDER BY paid_at DESC
  `;

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
