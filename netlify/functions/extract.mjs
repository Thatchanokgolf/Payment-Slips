import { extractSlip, BadImageError, Anthropic } from "../../lib/slip.js";
import { json } from "../../lib/http.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    const { image } = await req.json();
    const extracted = await extractSlip(image);
    return json(extracted);
  } catch (err) {
    console.error("extract error:", err);
    if (err instanceof BadImageError) return json({ error: err.message }, 400);
    // Surface the API's own message (billing, rate limit, etc.).
    if (err instanceof Anthropic.APIError) {
      return json({ error: err.error?.error?.message || err.message }, err.status || 502);
    }
    return json({ error: "Failed to analyze the slip." }, 500);
  }
};

export const config = { path: "/api/extract" };
