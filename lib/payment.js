// Thrown when a submitted payment fails validation.
export class BadRequestError extends Error {}

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

  return { when, receiver: receiver.trim(), amt, cat, notes: cleanNotes };
}
