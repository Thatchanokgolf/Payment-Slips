// Thrown when a submitted payment fails validation.
export class BadRequestError extends Error {}

// PIN that guards edit/delete. Configurable via the EDIT_PIN env var; defaults
// to 0112 so it works out of the box. Kept server-side — never shipped to the
// client, which only forwards whatever the user typed for checking here.
export function checkPin(pin) {
  return String(pin ?? "") === (process.env.EDIT_PIN || "0112");
}

// Validates and normalizes a payment payload. Returns the cleaned values ready
// for insertion, or throws BadRequestError with a user-facing message.
export function validatePayment(body) {
  const { paid_at, receiver, amount, category, notes } = body ?? {};

  const cat = Number(category);
  const amt = Number(amount);
  const when = new Date(paid_at);

  if (!receiver || typeof receiver !== "string") {
    throw new BadRequestError("Receiver name is required.");
  }
  if (!Number.isFinite(amt) || amt < 0) {
    throw new BadRequestError("Amount must be a non-negative number.");
  }
  if (!Number.isInteger(cat) || cat < 1 || cat > 10) {
    throw new BadRequestError("Category must be a whole number from 1 to 10.");
  }
  if (Number.isNaN(when.getTime())) {
    throw new BadRequestError("Payment date-time is invalid.");
  }

  // Notes are optional, free-text. Store null when blank.
  const cleanNotes = typeof notes === "string" && notes.trim() ? notes.trim() : null;

  // Keep the exact string the user entered for display (avoids timezone shifts);
  // `when` is the parsed Date used for the database.
  const paidAtRaw = typeof paid_at === "string" ? paid_at : when.toISOString();

  return { when, paidAtRaw, receiver: receiver.trim(), amt, cat, notes: cleanNotes };
}
