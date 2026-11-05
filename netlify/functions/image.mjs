import { getPaymentImage } from "../../lib/db.js";
import { json } from "../../lib/http.js";

// GET /api/image/:id — serve a stored slip image from the database.
export default async (req) => {
  const id = Number(new URL(req.url).pathname.split("/").pop());
  try {
    const img = await getPaymentImage(id);
    if (!img) return json({ error: "Image not found." }, 404);
    return new Response(Buffer.from(img.data, "base64"), {
      status: 200,
      headers: {
        "content-type": img.mime_type,
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    console.error("image error:", err);
    return json({ error: "Failed to load the image." }, 500);
  }
};

export const config = { path: "/api/image/:id" };
