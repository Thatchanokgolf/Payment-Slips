import { getSummary } from "../../lib/db.js";
import { json } from "../../lib/http.js";

export default async (req) => {
  try {
    const url = new URL(req.url);
    const start = url.searchParams.get("start");
    const end = url.searchParams.get("end");
    if (!start || !end) {
      return json({ error: "Both 'start' and 'end' dates are required." }, 400);
    }
    return json(await getSummary(start, end));
  } catch (err) {
    console.error("summary error:", err);
    return json({ error: "Failed to load the summary." }, 500);
  }
};

export const config = { path: "/api/summary" };
