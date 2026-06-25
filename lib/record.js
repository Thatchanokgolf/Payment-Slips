import { insertPayment, CATEGORIES } from "./db.js";
import { sheetsEnabled, appendPaymentRow } from "./sheets.js";

// Save a payment to Neon (the source of truth), then best-effort sync it to the
// Google Sheet. A Sheets/Drive failure is reported but never loses the record.
// `image` is the main slip; `extraImages` are up to two optional images that go
// only to the sheet (never the database).
export async function savePayment(fields, image, extraImages = []) {
  const row = await insertPayment(fields);

  const sheet = { enabled: sheetsEnabled, synced: false };
  if (sheetsEnabled) {
    try {
      await appendPaymentRow({ fields, categoryName: CATEGORIES[fields.cat], image, extraImages });
      sheet.synced = true;
    } catch (err) {
      console.error("sheet sync error:", err);
      sheet.error = err.message;
    }
  }

  return { ...row, sheet };
}
