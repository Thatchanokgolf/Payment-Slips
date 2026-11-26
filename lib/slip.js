// Extract payment-slip fields. Primary path is iApp Document OCR
// (https://iapp.co.th/en/docs/ocr/document), which reads the slip's text; the
// fields are then picked out of that text by lib/slipText.js. This is read from
// the printed slip, not verified with the bank. When iApp fails or the text has
// no amount or date, we fall back to Claude vision as a backup. Both return the
// same shape: { paid_at, receiver, amount, notes, source, sender, senderMatch }.

import Anthropic from "@anthropic-ai/sdk";
import { parseSlipText } from "./slipText.js";

const IAPP_URL = "https://api.iapp.co.th/v3/store/ocr/document/ocr";
const IAPP_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/gif"]);
const MODEL = "claude-opus-4-8";

// Constructing the client does not require the key yet — it's read per request.
const anthropic = new Anthropic();

// Thrown when the image is missing/unsupported or the slip can't be read at all
// (both iApp and the Claude backup failed) — surfaced as a 400 so the user
// can fix the image or type the details in.
export class BadImageError extends Error {}

// Thrown for service-level failures that carry an HTTP status to pass through.
export class SlipError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const DATA_URL_RE = /^data:image\/(?:png|jpe?g|webp|gif);base64,/;

// ---- Sender check: confirm the slip was sent FROM the configured account ----
// The sender is read by OCR, which misreads letters (x as O, ั as ิ) and slips
// mask most of the account and surname. So the account decides when it was
// read; the name can only confirm, never block.
const TITLES = /^(นาย|นางสาว|นาง|น\.ส\.|mr\.?|mrs\.?|ms\.?|miss)\s*/i;
const firstName = (s) =>
  String(s ?? "").trim().replace(TITLES, "").split(/\s+/)[0].toLowerCase();

// Edit distance, so one misread letter still counts as the same name.
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

function nameMatches(expected, actual) {
  const e = firstName(expected), a = firstName(actual);
  if (!e || !a) return false;
  return editDistance(e, a) <= (e.length >= 5 ? 1 : 0);
}

// The visible digits at the end of a masked account ("xxx-xxx186-3" → "1863").
// OCR may read the mask x as O/0, so only the run after the last mask counts.
function visibleTail(masked) {
  const m = String(masked ?? "").replace(/[oO*•]/g, "x").replace(/[^0-9xX]/g, "").toLowerCase();
  if (!m.includes("x")) return m; // unmasked: the whole number
  return m.slice(m.lastIndexOf("x") + 1);
}

// "ok" | "mismatch" (account read and it's a different one) | "unverified".
function checkSender(sender) {
  const expName = process.env.EXPECTED_SENDER_NAME;
  const expAcct = process.env.EXPECTED_SENDER_ACCOUNT;
  if (!expName && !expAcct) return "unverified"; // check not configured
  if (!sender) return "unverified"; // no sender data (e.g. Claude backup)

  const tail = visibleTail(sender.account);
  if (expAcct && tail.length >= 3) {
    const full = String(expAcct).replace(/\D/g, "");
    return full.endsWith(tail) ? "ok" : "mismatch";
  }
  // No usable account: a matching name confirms, a different one stays unverified.
  return expName && nameMatches(expName, sender.name) ? "ok" : "unverified";
}

// ---- Primary: iApp Document OCR + text parser -----------------------------
// iApp only returns the slip's plain text (no fields, no bank verification), so
// lib/slipText.js picks the fields out of it.
async function extractWithIapp(image) {
  const key = process.env.IAPP_API_KEY;
  if (!key) throw new SlipError("IAPP_API_KEY is not set.", 500);

  const [, mediaType, base64Data] = image.match(/^data:(image\/[a-z]+);base64,(.+)$/);
  if (!IAPP_TYPES.has(mediaType)) {
    throw new BadImageError("iApp can't read this image type (use JPEG, PNG, or GIF).");
  }
  const form = new FormData();
  const ext = mediaType.split("/")[1].replace("jpeg", "jpg");
  form.append("file", new Blob([Buffer.from(base64Data, "base64")], { type: mediaType }), `slip.${ext}`);

  let res;
  try {
    res = await fetch(IAPP_URL, { method: "POST", headers: { apikey: key }, body: form });
  } catch {
    throw new SlipError("Could not reach the iApp OCR service.", 502);
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON response — handled below */
  }

  if (!res.ok) {
    const detail = body?.message || body?.error || body?.detail;
    switch (res.status) {
      case 401:
      case 403:
        throw new SlipError("iApp rejected the API key (check IAPP_API_KEY).", 500);
      case 402:
        throw new SlipError("iApp account is out of credit.", 402);
      case 429:
        throw new SlipError("iApp rate limit reached — try again shortly.", 429);
      case 400:
      case 415:
        throw new BadImageError("iApp couldn't read this image.");
      default:
        throw new SlipError(
          (typeof detail === "string" && detail) || `iApp OCR failed (HTTP ${res.status}).`,
          502,
        );
    }
  }

  const text = Array.isArray(body?.text) ? body.text.join("\n") : String(body?.text ?? "");
  const fields = parseSlipText(text);
  // Nothing useful found — let the Claude backup try the image instead.
  if (fields.amount == null && fields.paid_at == null) {
    throw new BadImageError("Couldn't find the amount or date in this slip's text.");
  }
  return { ...fields, source: "iapp", senderMatch: checkSender(fields.sender) };
}

// ---- Backup: Claude vision -------------------------------------------------
const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    paid_at: {
      type: ["string", "null"],
      description:
        "Date and time of the payment in Gregorian ISO 8601 (e.g. 2026-06-20T22:10). Use null if not visible.",
    },
    receiver: {
      type: ["string", "null"],
      description: "Name of the person or company receiving the money (the TO / payee). Null if not visible.",
    },
    amount: {
      type: ["number", "null"],
      description: "Total amount of money paid, as a plain number with no currency symbol or commas. Null if not visible.",
    },
    notes: {
      type: ["string", "null"],
      description:
        "Any note, memo, or message attached to the payment — e.g. the 'NOTE' field on the slip. Transcribe it verbatim (keep the original language). Null if there is none.",
    },
  },
  required: ["paid_at", "receiver", "amount", "notes"],
  additionalProperties: false,
};

const PROMPT =
  "This is a payment slip / receipt. Extract the payment date-time, " +
  "the name of the receiver (payee), the total amount paid, and any note/memo " +
  "attached to the payment. Return null for any field you cannot read confidently.\n\n" +
  "Date handling: the slip may use the Thai Buddhist Era (B.E.) calendar " +
  "and Thai month names. Convert any B.E. year to the Gregorian year by " +
  "subtracting 543 (e.g. 2569 B.E. = 2026). Thai month abbreviations: " +
  "ม.ค.=Jan, ก.พ.=Feb, มี.ค.=Mar, เม.ย.=Apr, พ.ค.=May, มิ.ย.=Jun, " +
  "ก.ค.=Jul, ส.ค.=Aug, ก.ย.=Sep, ต.ค.=Oct, พ.ย.=Nov, ธ.ค.=Dec. " +
  "Always return paid_at as a Gregorian ISO 8601 value (e.g. 2026-06-20T22:10).";

async function extractWithClaude(image) {
  const match = image.match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/);
  if (!match) throw new BadImageError("Image must be a PNG, JPEG, WebP, or GIF data URL.");
  const [, mediaType, base64Data] = match;

  let response;
  try {
    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      output_config: { format: { type: "json_schema", schema: EXTRACT_SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    });
  } catch (err) {
    // Normalize Anthropic API failures (billing, rate limit, etc.) to SlipError.
    const status = err?.status || 502;
    const message = err?.error?.error?.message || err?.message || "AI extraction failed.";
    throw new SlipError(message, status);
  }

  if (response.stop_reason === "refusal") {
    throw new BadImageError("The image could not be processed.");
  }
  const text = response.content.find((b) => b.type === "text")?.text ?? "{}";
  // Claude can't see the sender account, so the sender check is unverifiable.
  return { ...JSON.parse(text), source: "claude", sender: null, senderMatch: "unverified" };
}

// ---- Public: iApp first, Claude as backup ----------------------------------
export async function extractSlip(image) {
  if (typeof image !== "string") {
    throw new BadImageError("Missing 'image' (data URL) in request body.");
  }
  if (!DATA_URL_RE.test(image)) {
    throw new BadImageError("Image must be a PNG, JPEG, WebP, or GIF data URL.");
  }

  try {
    return await extractWithIapp(image);
  } catch (iappErr) {
    console.warn("iApp failed, falling back to Claude:", iappErr.message);
    try {
      return await extractWithClaude(image);
    } catch (claudeErr) {
      // Both failed — surface the most actionable message (prefer "couldn't
      // read it, enter manually" over a transient service error).
      const actionable = [claudeErr, iappErr].find((e) => e instanceof BadImageError);
      if (actionable) throw actionable;
      const service = [iappErr, claudeErr].find((e) => e instanceof SlipError);
      throw service || new SlipError("Could not read the slip. Please enter the details manually.", 502);
    }
  }
}
