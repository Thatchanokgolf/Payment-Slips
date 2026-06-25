import Anthropic from "@anthropic-ai/sdk";

// Constructing the client does not require the key to be present yet — it's
// read when a request is made, so this is safe at module load.
const anthropic = new Anthropic();

const MODEL = "claude-opus-4-8";

// Thrown when the uploaded image is missing or not a supported data URL.
export class BadImageError extends Error {}

// JSON schema the model must fill in. Every field is nullable so the model can
// signal "I couldn't read this" instead of guessing.
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
  },
  required: ["paid_at", "receiver", "amount"],
  additionalProperties: false,
};

const PROMPT =
  "This is a payment slip / receipt. Extract the payment date-time, " +
  "the name of the receiver (payee), and the total amount paid. " +
  "Return null for any field you cannot read confidently.\n\n" +
  "Date handling: the slip may use the Thai Buddhist Era (B.E.) calendar " +
  "and Thai month names. Convert any B.E. year to the Gregorian year by " +
  "subtracting 543 (e.g. 2569 B.E. = 2026). Thai month abbreviations: " +
  "ม.ค.=Jan, ก.พ.=Feb, มี.ค.=Mar, เม.ย.=Apr, พ.ค.=May, มิ.ย.=Jun, " +
  "ก.ค.=Jul, ส.ค.=Aug, ก.ย.=Sep, ต.ค.=Oct, พ.ย.=Nov, ธ.ค.=Dec. " +
  "Always return paid_at as a Gregorian ISO 8601 value (e.g. 2026-06-20T22:10).";

// Sends a slip image to Claude vision and returns { paid_at, receiver, amount }.
// Throws BadImageError for bad input, or an Anthropic.APIError for API failures
// (billing, rate limits, etc.) — callers decide how to surface those.
export async function extractSlip(image) {
  if (typeof image !== "string") {
    throw new BadImageError("Missing 'image' (data URL) in request body.");
  }
  const match = image.match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/);
  if (!match) {
    throw new BadImageError("Image must be a PNG, JPEG, WebP, or GIF data URL.");
  }
  const [, mediaType, base64Data] = match;

  const response = await anthropic.messages.create({
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

  if (response.stop_reason === "refusal") {
    throw new BadImageError("The image could not be processed.");
  }

  const text = response.content.find((b) => b.type === "text")?.text ?? "{}";
  return JSON.parse(text);
}

export { Anthropic };
