import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sql, initDb, CATEGORIES } from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
// Slip images are base64-encoded in the JSON body, so allow a generous limit.
app.use(express.json({ limit: "15mb" }));
app.use(express.static(join(__dirname, "public")));

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

const MODEL = "claude-opus-4-8";

// JSON schema the model must fill in when reading a slip. Every field is
// nullable so the model can signal "I couldn't read this" instead of guessing.
const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    paid_at: {
      type: ["string", "null"],
      description:
        "Date and time of the payment in ISO 8601 (e.g. 2026-06-25T14:30). Use null if not visible.",
    },
    receiver: {
      type: ["string", "null"],
      description: "Name of the person or company receiving the money. Null if not visible.",
    },
    amount: {
      type: ["number", "null"],
      description: "Total amount of money paid, as a plain number with no currency symbol or commas. Null if not visible.",
    },
  },
  required: ["paid_at", "receiver", "amount"],
  additionalProperties: false,
};

// POST /api/extract — send an uploaded slip image to Claude and return the
// fields it reads, so the frontend can pre-fill the form for the user to review.
app.post("/api/extract", async (req, res) => {
  try {
    const { image } = req.body ?? {};
    if (typeof image !== "string") {
      return res.status(400).json({ error: "Missing 'image' (data URL) in request body." });
    }

    // Frontend sends a data URL: "data:image/png;base64,iVBORw0K..."
    const match = image.match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ error: "Image must be a PNG, JPEG, WebP, or GIF data URL." });
    }
    const [, mediaType, base64Data] = match;

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      output_config: { format: { type: "json_schema", schema: EXTRACT_SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: base64Data },
            },
            {
              type: "text",
              text:
                "This is a payment slip / receipt. Extract the payment date-time, " +
                "the name of the receiver (payee), and the total amount paid. " +
                "Return null for any field you cannot read confidently.\n\n" +
                "Date handling: the slip may use the Thai Buddhist Era (B.E.) calendar " +
                "and Thai month names. Convert any B.E. year to the Gregorian year by " +
                "subtracting 543 (e.g. 2569 B.E. = 2026). Thai month abbreviations: " +
                "ม.ค.=Jan, ก.พ.=Feb, มี.ค.=Mar, เม.ย.=Apr, พ.ค.=May, มิ.ย.=Jun, " +
                "ก.ค.=Jul, ส.ค.=Aug, ก.ย.=Sep, ต.ค.=Oct, พ.ย.=Nov, ธ.ค.=Dec. " +
                "Always return paid_at as a Gregorian ISO 8601 value (e.g. 2026-06-20T22:10).",
            },
          ],
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      return res.status(422).json({ error: "The image could not be processed." });
    }

    const text = response.content.find((b) => b.type === "text")?.text ?? "{}";
    const extracted = JSON.parse(text);
    res.json(extracted);
  } catch (err) {
    console.error("extract error:", err);
    // Surface the API's own message (billing, rate limit, etc.) so the user
    // sees the real reason instead of a generic failure.
    if (err instanceof Anthropic.APIError) {
      const apiMessage = err.error?.error?.message || err.message;
      return res.status(err.status || 502).json({ error: apiMessage });
    }
    res.status(500).json({ error: "Failed to analyze the slip." });
  }
});

// POST /api/payments — save a reviewed payment record.
app.post("/api/payments", async (req, res) => {
  try {
    const { paid_at, receiver, amount, category } = req.body ?? {};

    const cat = Number(category);
    const amt = Number(amount);
    const when = new Date(paid_at);

    if (!receiver || typeof receiver !== "string") {
      return res.status(400).json({ error: "Receiver name is required." });
    }
    if (!Number.isFinite(amt) || amt < 0) {
      return res.status(400).json({ error: "Amount must be a non-negative number." });
    }
    if (!Number.isInteger(cat) || cat < 1 || cat > 10) {
      return res.status(400).json({ error: "Category must be a whole number from 1 to 10." });
    }
    if (Number.isNaN(when.getTime())) {
      return res.status(400).json({ error: "Payment date-time is invalid." });
    }

    const [row] = await sql`
      INSERT INTO payments (paid_at, receiver, amount, category)
      VALUES (${when.toISOString()}, ${receiver.trim()}, ${amt}, ${cat})
      RETURNING id, paid_at, receiver, amount, category
    `;
    res.status(201).json(row);
  } catch (err) {
    console.error("save error:", err);
    res.status(500).json({ error: "Failed to save the payment." });
  }
});

// GET /api/summary?start=YYYY-MM-DD&end=YYYY-MM-DD — overall totals plus a
// per-category breakdown for payments between the two dates (inclusive).
app.get("/api/summary", async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ error: "Both 'start' and 'end' dates are required." });
    }
    // Make 'end' inclusive of the whole day by querying up to the next midnight.
    const endExclusive = new Date(`${end}T00:00:00`);
    endExclusive.setDate(endExclusive.getDate() + 1);

    const byCategory = await sql`
      SELECT category,
             COUNT(*)::int      AS count,
             SUM(amount)::float AS total
      FROM payments
      WHERE paid_at >= ${`${start}T00:00:00`}
        AND paid_at <  ${endExclusive.toISOString()}
      GROUP BY category
      ORDER BY category
    `;

    const payments = await sql`
      SELECT id, paid_at, receiver, amount::float AS amount, category
      FROM payments
      WHERE paid_at >= ${`${start}T00:00:00`}
        AND paid_at <  ${endExclusive.toISOString()}
      ORDER BY paid_at DESC
    `;

    const grandTotal = byCategory.reduce((acc, r) => acc + r.total, 0);
    const totalCount = byCategory.reduce((acc, r) => acc + r.count, 0);

    res.json({
      start,
      end,
      grandTotal,
      totalCount,
      byCategory: byCategory.map((r) => ({
        category: r.category,
        name: CATEGORIES[r.category],
        count: r.count,
        total: r.total,
      })),
      payments,
    });
  } catch (err) {
    console.error("summary error:", err);
    res.status(500).json({ error: "Failed to load the summary." });
  }
});

// Expose the category labels so the frontend stays in sync with the backend.
app.get("/api/categories", (_req, res) => {
  res.json(CATEGORIES.map((name, value) => (name ? { value, name } : null)).filter(Boolean));
});

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Payment Slip Analyzer running at http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error("Failed to initialize the database:", err);
    process.exit(1);
  });
