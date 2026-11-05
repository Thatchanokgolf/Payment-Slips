// Local development server. In production on Netlify the same logic runs as
// serverless functions (see netlify/functions/), sharing the modules in lib/.
import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ensureDb, getSummary, getPaymentImage, CATEGORIES } from "./lib/db.js";
import { extractSlip, BadImageError, Anthropic } from "./lib/slip.js";
import { validatePayment, BadRequestError } from "./lib/payment.js";
import { savePayment, updatePaymentRecord, deletePaymentRecord } from "./lib/record.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
// Slip images are base64-encoded in the JSON body, so allow a generous limit.
app.use(express.json({ limit: "15mb" }));
app.use(express.static(join(__dirname, "public")));

// POST /api/extract — read an uploaded slip image with Claude vision.
app.post("/api/extract", async (req, res) => {
  try {
    const extracted = await extractSlip(req.body?.image);
    res.json(extracted);
  } catch (err) {
    console.error("extract error:", err);
    if (err instanceof BadImageError) return res.status(400).json({ error: err.message });
    if (err instanceof Anthropic.APIError) {
      return res.status(err.status || 502).json({ error: err.error?.error?.message || err.message });
    }
    res.status(500).json({ error: "Failed to analyze the slip." });
  }
});

// POST /api/payments — save a reviewed payment record.
app.post("/api/payments", async (req, res) => {
  try {
    const fields = validatePayment(req.body);
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const row = await savePayment(fields, req.body?.image, req.body?.extraImages, baseUrl);
    res.status(201).json(row);
  } catch (err) {
    if (err instanceof BadRequestError) return res.status(400).json({ error: err.message });
    console.error("save error:", err);
    res.status(500).json({ error: "Failed to save the payment." });
  }
});

// PUT /api/payments/:id — update a payment, syncing its Google Sheet row.
app.put("/api/payments/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid payment id." });
    const fields = validatePayment(req.body);
    const row = await updatePaymentRecord(id, fields);
    if (!row) return res.status(404).json({ error: "Payment not found." });
    res.json(row);
  } catch (err) {
    if (err instanceof BadRequestError) return res.status(400).json({ error: err.message });
    console.error("update error:", err);
    res.status(500).json({ error: "Failed to update the payment." });
  }
});

// DELETE /api/payments/:id — delete a payment (and its images), removing its
// Google Sheet row.
app.delete("/api/payments/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid payment id." });
    const row = await deletePaymentRecord(id);
    if (!row) return res.status(404).json({ error: "Payment not found." });
    res.json(row);
  } catch (err) {
    console.error("delete error:", err);
    res.status(500).json({ error: "Failed to delete the payment." });
  }
});

// GET /api/image/:id — serve a stored slip image from the database.
app.get("/api/image/:id", async (req, res) => {
  try {
    const img = await getPaymentImage(Number(req.params.id));
    if (!img) return res.status(404).json({ error: "Image not found." });
    res.setHeader("Content-Type", img.mime_type);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.send(Buffer.from(img.data, "base64"));
  } catch (err) {
    console.error("image error:", err);
    res.status(500).json({ error: "Failed to load the image." });
  }
});

// GET /api/summary?start=YYYY-MM-DD&end=YYYY-MM-DD — totals + breakdown + rows.
app.get("/api/summary", async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ error: "Both 'start' and 'end' dates are required." });
    }
    res.json(await getSummary(start, end));
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

ensureDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Payment Slip Analyzer running at http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error("Failed to initialize the database:", err);
    process.exit(1);
  });
