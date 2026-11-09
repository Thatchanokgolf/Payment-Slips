// Extract payment-slip fields. Primary path is EasySlip
// (https://document.easyslip.com/en/v2/verify/bank), which reads the slip's QR
// and returns bank-verified data — exact, not guessed. When EasySlip can't
// verify a slip (no/unreadable QR, quota, pending, service down, or no token),
// we fall back to Claude vision as a backup. Both return the same shape:
// { paid_at, receiver, amount, notes, source }.

import Anthropic from "@anthropic-ai/sdk";

const EASYSLIP_URL = "https://api.easyslip.com/v2/verify/bank";
const MODEL = "claude-opus-4-8";

// Constructing the client does not require the key yet — it's read per request.
const anthropic = new Anthropic();

// Thrown when the image is missing/unsupported or the slip can't be read at all
// (both EasySlip and the Claude backup failed) — surfaced as a 400 so the user
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
const normName = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();
const normAcct = (s) => String(s ?? "").replace(/[^0-9xX]/g, "").toLowerCase();

function nameMatches(expected, actual) {
  const e = normName(expected), a = normName(actual);
  if (!e || !a) return false;
  return e === a || a.includes(e) || e.includes(a);
}

// Compare a full expected account number against a bank-masked one
// (e.g. "123-4-xxxxx-5"): same length, and every un-masked digit must line up.
function accountMatches(expected, masked) {
  const e = normAcct(expected), m = normAcct(masked);
  if (!e || !m || e.length !== m.length) return false;
  for (let i = 0; i < m.length; i++) {
    if (m[i] === "x") continue;
    if (m[i] !== e[i]) return false;
  }
  return true;
}

// "ok" (matches configured account) | "mismatch" (different account) |
// "unverified" (no expected account configured, or no sender data available).
function checkSender(sender) {
  const expName = process.env.EXPECTED_SENDER_NAME;
  const expAcct = process.env.EXPECTED_SENDER_ACCOUNT;
  if (!expName && !expAcct) return "unverified"; // check not configured
  if (!sender) return "unverified"; // no sender data (e.g. Claude backup)
  const nameOk = !expName || nameMatches(expName, sender.name);
  const acctOk = !expAcct || accountMatches(expAcct, sender.account);
  return nameOk && acctOk ? "ok" : "mismatch";
}

// ---- Primary: EasySlip QR verification -------------------------------------
async function extractWithEasySlip(image) {
  const token = process.env.EASYSLIP_API_KEY;
  if (!token) throw new SlipError("EASYSLIP_API_KEY is not set.", 500);

  let res;
  try {
    res = await fetch(EASYSLIP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ base64: image }),
    });
  } catch {
    throw new SlipError("Could not reach the slip verification service.", 502);
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON response — handled below */
  }

  if (!res.ok || !body?.success) {
    const code = body?.error?.code;
    const message = body?.error?.message;
    switch (code) {
      case "SLIP_NOT_FOUND":
        throw new BadImageError("This slip couldn't be verified.");
      case "VALIDATION_ERROR":
        throw new BadImageError(message || "The slip image was rejected (QR not clearly visible).");
      case "SLIP_PENDING":
        throw new SlipError("This Bangkok Bank slip isn't ready yet — wait a few minutes and try again.", 409);
      case "QUOTA_EXCEEDED":
        throw new SlipError("Monthly slip-verification quota exceeded.", 429);
      default:
        throw new SlipError(message || `Slip verification failed (HTTP ${res.status}).`, res.status || 502);
    }
  }

  const slip = body.data?.rawSlip ?? {};
  const rcv = slip.receiver?.account?.name;
  const s = slip.sender;
  const sender = s
    ? {
        name: s.account?.name?.th ?? s.account?.name?.en ?? null,
        account: s.account?.bank?.account ?? null,
        bank: s.bank?.short ?? s.bank?.name ?? null,
      }
    : null;
  return {
    paid_at: slip.date ?? null, // ISO 8601, e.g. "2026-06-20T22:10:00+07:00"
    receiver: rcv?.th ?? rcv?.en ?? null,
    amount: slip.amount?.amount ?? body.data?.amountInSlip ?? null,
    notes: null, // EasySlip doesn't return the slip's personal memo
    source: "easyslip",
    sender,
    senderMatch: checkSender(sender),
  };
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

// ---- Public: EasySlip first, Claude as backup ------------------------------
export async function extractSlip(image) {
  if (typeof image !== "string") {
    throw new BadImageError("Missing 'image' (data URL) in request body.");
  }
  if (!DATA_URL_RE.test(image)) {
    throw new BadImageError("Image must be a PNG, JPEG, WebP, or GIF data URL.");
  }

  try {
    return await extractWithEasySlip(image);
  } catch (easyErr) {
    console.warn("EasySlip failed, falling back to Claude:", easyErr.message);
    try {
      return await extractWithClaude(image);
    } catch (claudeErr) {
      // Both failed — surface the most actionable message (prefer "couldn't
      // read it, enter manually" over a transient service error).
      const actionable = [claudeErr, easyErr].find((e) => e instanceof BadImageError);
      if (actionable) throw actionable;
      const service = [easyErr, claudeErr].find((e) => e instanceof SlipError);
      throw service || new SlipError("Could not read the slip. Please enter the details manually.", 502);
    }
  }
}
