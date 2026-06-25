import { validatePayment, BadRequestError } from "../../lib/payment.js";
import { savePayment } from "../../lib/record.js";
import { json } from "../../lib/http.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    const body = await req.json();
    const fields = validatePayment(body);
    const row = await savePayment(fields, body.image);
    return json(row, 201);
  } catch (err) {
    if (err instanceof BadRequestError) return json({ error: err.message }, 400);
    console.error("save error:", err);
    return json({ error: "Failed to save the payment." }, 500);
  }
};

export const config = { path: "/api/payments" };
