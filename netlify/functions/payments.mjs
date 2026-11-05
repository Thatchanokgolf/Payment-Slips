import { validatePayment, BadRequestError, checkPin } from "../../lib/payment.js";
import { savePayment, updatePaymentRecord, deletePaymentRecord } from "../../lib/record.js";
import { json } from "../../lib/http.js";

// Pull the trailing :id from /api/payments/:id, or null for /api/payments.
const idFromUrl = (req) => {
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const last = parts[parts.length - 1];
  return last === "payments" ? null : Number(last);
};

export default async (req) => {
  try {
    if (req.method === "POST") {
      const body = await req.json();
      const fields = validatePayment(body);
      // Site origin for building /api/image/:id URLs the Sheet's =IMAGE() uses.
      const baseUrl = process.env.URL || new URL(req.url).origin;
      const row = await savePayment(fields, body.image, body.extraImages, baseUrl);
      return json(row, 201);
    }

    if (req.method === "PUT") {
      if (!checkPin(req.headers.get("x-edit-pin"))) return json({ error: "Incorrect PIN." }, 401);
      const id = idFromUrl(req);
      if (!Number.isInteger(id)) return json({ error: "Invalid payment id." }, 400);
      const fields = validatePayment(await req.json());
      const row = await updatePaymentRecord(id, fields);
      if (!row) return json({ error: "Payment not found." }, 404);
      return json(row);
    }

    if (req.method === "DELETE") {
      if (!checkPin(req.headers.get("x-edit-pin"))) return json({ error: "Incorrect PIN." }, 401);
      const id = idFromUrl(req);
      if (!Number.isInteger(id)) return json({ error: "Invalid payment id." }, 400);
      const row = await deletePaymentRecord(id);
      if (!row) return json({ error: "Payment not found." }, 404);
      return json(row);
    }

    return json({ error: "Method not allowed." }, 405);
  } catch (err) {
    if (err instanceof BadRequestError) return json({ error: err.message }, 400);
    console.error("payments error:", err);
    return json({ error: "Request failed." }, 500);
  }
};

export const config = { path: ["/api/payments", "/api/payments/:id"] };
