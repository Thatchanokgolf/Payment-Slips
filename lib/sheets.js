import { google } from "googleapis";

const { GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY } = process.env;

// Target Sheet + tab. These are not secrets (just resource IDs, gated by Google
// sharing), so they default to the project's configured destination and can
// still be overridden via env if needed.
const SHEET_ID = process.env.GOOGLE_SHEET_ID || "1fx13JWUjLfOk2SL_OzUXk7MIXveOi7uAvwonEp5VpJg";
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "ฟอร์มจ่ายเงินใหม่";

// The sync is opt-in: it only runs once the service-account credentials are set.
export const sheetsEnabled = Boolean(GOOGLE_SERVICE_ACCOUNT_EMAIL && GOOGLE_PRIVATE_KEY);

function getAuth() {
  return new google.auth.JWT({
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    // .env stores the key on one line with literal \n; turn those into newlines.
    key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    // Only the Sheets scope is needed now — images live in the database and are
    // served from /api/image/:id, so no Google Drive access is required.
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

// A1 range on the target tab. The tab name is single-quoted (and any inner
// quotes doubled) so non-ASCII / spaces in the name are handled correctly.
const cell = (a1) => `'${SHEET_TAB.replace(/'/g, "''")}'!${a1}`;

// An =IMAGE() cell pointing at the given public URL, or "" when there's none.
const imageCell = (url) => (url ? `=IMAGE("${url}")` : "");

// Append one payment as a new row on the target tab. `imageUrls` is up to three
// public /api/image/:id URLs ([slip, extra1, extra2]); any missing entry leaves
// its image cell blank. Built straight from the submitted fields — it does not
// read the sheet's existing state.
export async function appendPaymentRow({ paymentId, fields, categoryName, imageUrls = [] }) {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  // Column order matches the sheet header:
  // id | Date&Time | Receiver | Amount | Category | Notes | Payment slip image | Extra 1 | Extra 2
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: cell("A1"),
    valueInputOption: "USER_ENTERED", // so =IMAGE is parsed as a formula
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[
        paymentId,
        (fields.paidAtRaw || "").replace("T", " "),
        fields.receiver,
        fields.amt,
        `${fields.cat}. ${categoryName}`,
        fields.notes || "",
        imageCell(imageUrls[0]),
        imageCell(imageUrls[1]),
        imageCell(imageUrls[2]),
      ]],
    },
  });
}
