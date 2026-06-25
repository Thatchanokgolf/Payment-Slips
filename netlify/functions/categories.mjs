import { CATEGORIES } from "../../lib/db.js";
import { json } from "../../lib/http.js";

export default async () =>
  json(CATEGORIES.map((name, value) => (name ? { value, name } : null)).filter(Boolean));

export const config = { path: "/api/categories" };
