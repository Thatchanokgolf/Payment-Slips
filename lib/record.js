import { insertPayment, insertPaymentImage, CATEGORIES } from "./db.js";
import { sheetsEnabled, appendPaymentRow } from "./sheets.js";

// Parse a base64 image data URL into { mime, data } (raw base64), or null.
function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  return m ? { mime: m[1], data: m[2] } : null;
}

// Save a payment to Neon (the source of truth): first the row, then the slip
// image plus up to two optional extras into payment_images (slot 0 = slip,
// 1-2 = extras). The stored images are served from GET /api/image/:id, and
// those public URLs are what the Google Sheet's =IMAGE() cells point at.
//
// `baseUrl` is the site origin (e.g. https://site.netlify.app) used to build
// those URLs; when it's missing the images are still stored, the sheet cells
// just stay blank. A Sheets failure is reported but never loses the record.
export async function savePayment(fields, image, extraImages = [], baseUrl) {
  const row = await insertPayment(fields);

  // Store each present image and remember its id, keyed by slot.
  const sources = [image, extraImages[0], extraImages[1]];
  const imageIds = [null, null, null];
  for (let slot = 0; slot < sources.length; slot++) {
    const parsed = parseDataUrl(sources[slot]);
    if (!parsed) continue;
    const img = await insertPaymentImage({ paymentId: row.id, slot, mime: parsed.mime, data: parsed.data });
    imageIds[slot] = img.id;
  }

  const toUrl = (id) => (id && baseUrl ? `${baseUrl}/api/image/${id}` : null);
  const imageUrls = imageIds.map(toUrl);

  const sheet = { enabled: sheetsEnabled, synced: false };
  if (sheetsEnabled) {
    try {
      await appendPaymentRow({ fields, categoryName: CATEGORIES[fields.cat], imageUrls });
      sheet.synced = true;
    } catch (err) {
      console.error("sheet sync error:", err);
      sheet.error = err.message;
    }
  }

  const images = imageIds
    .map((id, slot) => (id ? { id, slot } : null))
    .filter(Boolean);

  return { ...row, images, sheet };
}
