import { google } from "googleapis";
import { Readable } from "node:stream";

const { GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY } = process.env;

// Target Sheet, tab, and Drive folder. These are not secrets (they're just
// resource IDs, gated by Google sharing), so they default to the project's
// configured destinations and can still be overridden via env if needed.
const SHEET_ID = process.env.GOOGLE_SHEET_ID || "1fx13JWUjLfOk2SL_OzUXk7MIXveOi7uAvwonEp5VpJg";
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "ฟอร์มจ่ายเงินใหม่";
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || "1I_iF6V5I2WGqm3UCLT9z-di6C8Dknh8L";

// The sync is opt-in: it only runs once the service-account credentials are set.
export const sheetsEnabled = Boolean(GOOGLE_SERVICE_ACCOUNT_EMAIL && GOOGLE_PRIVATE_KEY);

function getAuth() {
  return new google.auth.JWT({
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    // .env stores the key on one line with literal \n; turn those into newlines.
    key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive",
    ],
  });
}

// A1 range on the target tab. The tab name is single-quoted (and any inner
// quotes doubled) so non-ASCII / spaces in the name are handled correctly.
const cell = (a1) => `'${SHEET_TAB.replace(/'/g, "''")}'!${a1}`;

// Upload a base64 data-URL image to the Drive folder and make it link-readable.
// Returns { viewUrl, imageUrl } or null when there's no image.
async function uploadImage(auth, dataUrl, filename) {
  if (!dataUrl || !DRIVE_FOLDER_ID) return null;
  const m = dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!m) return null;
  const [, mimeType, b64] = m;

  const drive = google.drive({ version: "v3", auth });
  const { data } = await drive.files.create({
    requestBody: { name: filename, parents: [DRIVE_FOLDER_ID] },
    media: { mimeType, body: Readable.from(Buffer.from(b64, "base64")) },
    fields: "id, webViewLink",
    supportsAllDrives: true, // allows uploading into a Shared Drive folder
  });

  // Anyone with the link can view — required for the sheet's =IMAGE() to render.
  await drive.permissions.create({
    fileId: data.id,
    requestBody: { role: "reader", type: "anyone" },
    supportsAllDrives: true,
  });

  return {
    viewUrl: data.webViewLink || `https://drive.google.com/file/d/${data.id}/view`,
    imageUrl: `https://drive.google.com/thumbnail?id=${data.id}&sz=w1000`,
  };
}

// Upload one image (best-effort) and return its =IMAGE() cell, or "" if there's
// no image or the upload fails (e.g. a service account with no storage quota on
// a non-Shared-Drive folder) — so a failed image never aborts the whole sync.
async function imageCellFor(auth, dataUrl, filename) {
  if (!dataUrl) return "";
  try {
    const uploaded = await uploadImage(auth, dataUrl, filename);
    return uploaded ? `=IMAGE("${uploaded.imageUrl}")` : "";
  } catch (err) {
    console.error("slip image upload failed:", err.message);
    return "";
  }
}

// Append one payment as a new row on the target tab, uploading its slip image
// plus up to two optional extra images. Built straight from the submitted form
// fields — does not read the sheet's existing state.
export async function appendPaymentRow({ fields, categoryName, image, extraImages = [] }) {
  const auth = getAuth();
  const ts = Date.now();

  const imageCell = await imageCellFor(auth, image, `slip-${ts}.jpg`);
  // Always emit exactly two extra-image cells so they land in the rightmost
  // two columns regardless of how many were attached.
  const extra1 = await imageCellFor(auth, extraImages[0], `slip-${ts}-extra1.jpg`);
  const extra2 = await imageCellFor(auth, extraImages[1], `slip-${ts}-extra2.jpg`);

  const sheets = google.sheets({ version: "v4", auth });
  // Column order matches the sheet header:
  // Date&Time | Receiver | Amount | Category | Notes | Payment slip image | Extra 1 | Extra 2
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: cell("A1"),
    valueInputOption: "USER_ENTERED", // so =IMAGE is parsed as a formula
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[
        (fields.paidAtRaw || "").replace("T", " "),
        fields.receiver,
        fields.amt,
        `${fields.cat}. ${categoryName}`,
        fields.notes || "",
        imageCell,
        extra1,
        extra2,
      ]],
    },
  });
}
