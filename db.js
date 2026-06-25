import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and add your Neon connection string.");
}

// Neon's serverless driver exposes a tagged-template `sql` function that runs
// each query over HTTPS. Interpolated values are sent as parameters, not string
// concatenation, so this is safe against SQL injection.
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

export async function initDb() {
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
}
