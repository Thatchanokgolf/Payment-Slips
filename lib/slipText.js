// Turn the raw OCR text of a Thai bank transfer slip into form fields.
// The OCR (iApp Document OCR) returns only plain text lines, so this file finds
// the date-time, amount, sender, receiver and memo with patterns that cover the
// common Thai bank apps (K PLUS, SCB EASY, Krungthai NEXT, Bualuang, KMA, ttb,
// MyMo, PromptPay e-wallets). Anything it can't find comes back as null.
//
// parseSlipText(text) → { paid_at, receiver, amount, notes, sender }
//   paid_at: "YYYY-MM-DDTHH:MM" (slip's wall-clock time, Gregorian) or null
//   sender:  { name, account, bank } or null

const THAI_DIGITS = "๐๑๒๓๔๕๖๗๘๙";
const toArabic = (s) => s.replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)));

// Month names → 1..12. Keys are compared after removing dots and spaces.
const MONTHS = new Map([
  ["มค", 1], ["มกราคม", 1], ["กพ", 2], ["กุมภาพันธ์", 2], ["มีค", 3], ["มีนาคม", 3],
  ["เมย", 4], ["เมษายน", 4], ["พค", 5], ["พฤษภาคม", 5], ["มิย", 6], ["มิถุนายน", 6],
  ["กค", 7], ["กรกฎาคม", 7], ["สค", 8], ["สิงหาคม", 8], ["กย", 9], ["กันยายน", 9],
  ["ตค", 10], ["ตุลาคม", 10], ["พย", 11], ["พฤศจิกายน", 11], ["ธค", 12], ["ธันวาคม", 12],
  ["jan", 1], ["feb", 2], ["mar", 3], ["apr", 4], ["may", 5], ["jun", 6],
  ["jul", 7], ["aug", 8], ["sep", 9], ["sept", 9], ["oct", 10], ["nov", 11], ["dec", 12],
  ["january", 1], ["february", 2], ["march", 3], ["april", 4], ["june", 6], ["july", 7],
  ["august", 8], ["september", 9], ["october", 10], ["november", 11], ["december", 12],
]);
const monthOf = (word) => MONTHS.get(word.replace(/[.\s]/g, "").toLowerCase()) ?? null;

// 2-digit years: 50–99 are Buddhist Era (25xx), below that Gregorian (20xx).
// 4-digit years above 2400 are Buddhist Era.
function toGregorianYear(y) {
  let n = Number(y);
  if (y.length <= 2) n = n >= 50 ? 2500 + n : 2000 + n;
  if (n > 2400) n -= 543;
  return n;
}

const pad = (n) => String(n).padStart(2, "0");

// Month token: Thai abbreviation with dots (พ.ย.), Thai full name, or English.
const MONTH_RE = "([ก-๙]{1,3}\\.\\s?[ก-๙]{1,2}\\.?|[ก-๙]{4,12}|[A-Za-z]{3,9}\\.?)";
const TEXT_DATE_RE = new RegExp(`(\\d{1,2})\\s*${MONTH_RE}\\s*(\\d{4}|\\d{2})(?!\\d)`);
const NUM_DATE_RE = /(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})(?!\d)/;
const TIME_RE = /(?<![\d.,])([01]?\d|2[0-3])[:.]([0-5]\d)(?::[0-5]\d)?(?![\d,])(?!\.\d)/;

function findDate(lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let day, month, year, rest;
    const t = line.match(TEXT_DATE_RE);
    if (t && monthOf(t[2])) {
      [day, month, year] = [Number(t[1]), monthOf(t[2]), toGregorianYear(t[3])];
      rest = line.slice(t.index + t[0].length);
    } else {
      const n = line.match(NUM_DATE_RE);
      if (!n) continue;
      [day, month, year] = [Number(n[1]), Number(n[2]), toGregorianYear(n[3])];
      rest = line.slice(n.index + n[0].length);
    }
    if (day < 1 || day > 31 || month < 1 || month > 12 || year < 2000 || year > 2100) continue;
    // Time is usually after the date on the same line, else on a nearby line.
    const time =
      rest.match(TIME_RE) ||
      line.match(TIME_RE) ||
      lines.slice(i + 1, i + 3).map((l) => l.match(TIME_RE)).find(Boolean) ||
      (i > 0 && lines[i - 1].match(TIME_RE));
    const hm = time ? `T${pad(time[1])}:${time[2]}` : "T00:00";
    return `${year}-${pad(month)}-${pad(day)}${hm}`;
  }
  return null;
}

// ---- Amount ----------------------------------------------------------------
const MONEY_RE = /(?<![\d,.])(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{2}|\d+)(?![\d,]|\.\d)/g;
const AMOUNT_LABEL = /จำนวนเงิน|จำนวน|ยอดเงิน|ยอดโอน|ยอดชำระ|ยอดรวม|amount|total/i;
const FEE_LABEL = /ค่าธรรมเนียม|fee|charge/i;
const CURRENCY = /บาท|thb|฿/i;

const toNumber = (s) => Number(s.replace(/,/g, ""));
const moneyIn = (line) =>
  [...line.matchAll(MONEY_RE)].map((m) => toNumber(m[1])).filter((n) => n > 0);

function findAmount(lines) {
  // 1) A labelled line ("จำนวนเงิน 1,500.00 บาท"), or the line right after the label.
  for (let i = 0; i < lines.length; i++) {
    if (!AMOUNT_LABEL.test(lines[i]) || FEE_LABEL.test(lines[i])) continue;
    const here = moneyIn(lines[i].replace(AMOUNT_LABEL, " "));
    if (here.length) return here[0];
    const next = lines[i + 1];
    if (next && !FEE_LABEL.test(next)) {
      const n = moneyIn(next);
      if (n.length) return n[0];
    }
  }
  // 2) Any money figure followed by บาท / THB / ฿ (not the fee).
  for (const line of lines) {
    if (FEE_LABEL.test(line) || !CURRENCY.test(line)) continue;
    const m = line.match(/(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(?:บาท|thb|฿)/i);
    if (m && toNumber(m[1]) > 0) return toNumber(m[1]);
  }
  // 3) A line that is only a decimal amount ("1,500.00").
  for (const line of lines) {
    const m = line.match(/^฿?\s*(\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2})$/);
    if (m && toNumber(m[1]) > 0) return toNumber(m[1]);
  }
  return null;
}

// ---- Parties (sender / receiver) ------------------------------------------
// Bank account / PromptPay / wallet numbers, usually masked: "xxx-x-x1234-x",
// "123-4-56789-0", "xxx-xxx-1234", "XXXX XXXX 1234".
const ACCOUNT_RE = /(?<![\w-])([xX*•oO\d]{1,4}(?:[-\s][xX*•oO\d]{1,8}){1,4})(?![\w-])/;
const BANK_RE =
  /^(ธ\.|ธนาคาร|bank\b|กสิกร|ไทยพาณิชย์|กรุงไทย|กรุงเทพ|กรุงศรี|ทหารไทย|ttb|ออมสิน|ธกส|ธ\.ก\.ส|อาคารสงเคราะห์|ยูโอบี|ซีไอเอ็มบี|แลนด์|เกียรตินาคิน|ทิสโก้|พร้อมเพย์|promptpay|truemoney|ทรูมันนี่|kbank|scb|ktb|bbl|bay|gsb|baac|ghb|uob|cimb|kkp|tisco|lh bank)/i;
const FROM_LABEL = /^(จาก|ผู้โอน|from\b)\s*[:：]?\s*/i;
const TO_LABEL = /^([ไโ]ปย.?ง|ไปที่|ถึง|ผู้รับ(?:เงิน)?|to\b)\s*[:：]?\s*/i;
const TITLE_RE =
  /^(นาย|นางสาว|นาง|น\.ส\.|ด\.ช\.|ด\.ญ\.|ว่าที่|บจก|บมจ|บริษัท|หจก|ร้าน|mr\.?|mrs\.?|ms\.?|miss)\s*\S/i;
// Lines that are slip chrome, never a person's name.
const NOISE_RE =
  /โอนเงินสำเร็จ|ทำรายการสำเร็จ|สำเร็จ|เลขที่รายการ|รหัสอ้างอิง|ref|transaction|ค่าธรรมเนียม|จำนวน|บาท|amount|fee|thb|สแกน|ตรวจสอบ|qr|รายการ|วันที่|เวลา|^[\s\p{P}\p{S}]*$/iu;

const isAccount = (line) => {
  const m = line.match(ACCOUNT_RE);
  if (!m) return null;
  const chars = m[1].replace(/[-\s]/g, "");
  // Must look like an account: 4+ chars with a digit and a mask (or 9+ digits).
  if (!/\d/.test(chars) || /[:.,/]/.test(m[1])) return null;
  if (chars.length < 9 && !/[xX*•oO]/.test(chars)) return null;
  if (chars.length < 4) return null;
  return m[1].replace(/\s+/g, "-");
};
const isBank = (line) => BANK_RE.test(line.trim());
const isNameCandidate = (line) =>
  line.length >= 2 && !isBank(line) && !isAccount(line) && !NOISE_RE.test(line) && !/^\d/.test(line);

const LOGO_JUNK = /^[A-Za-z]{1,3}\s+(?=[ก-๙])/;
function partyAt(lines, nameIdx) {
  const name = lines[nameIdx].replace(FROM_LABEL, "").replace(TO_LABEL, "").trim().replace(LOGO_JUNK, "");
  let bank = null, account = null;
  for (const line of lines.slice(nameIdx + 1, nameIdx + 4)) {
    if (!bank && isBank(line)) bank = line.trim();
    else if (!account && isAccount(line)) account = isAccount(line);
    if (FROM_LABEL.test(line) || TO_LABEL.test(line)) break;
  }
  return { name: name || null, account, bank };
}

// Name for a labelled party: rest of the label line, or the next usable line.
function labelledParty(lines, label) {
  const i = lines.findIndex((l) => label.test(l));
  if (i < 0) return null;
  const rest = lines[i].replace(label, "").trim();
  // A name right after the label may start with a digit ("To 7-ELEVEN").
  if (rest && !isBank(rest) && !isAccount(rest) && !NOISE_RE.test(rest)) return partyAt([rest, ...lines.slice(i + 1)], 0);
  for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
    if (isNameCandidate(lines[j])) return partyAt(lines, j);
  }
  return null;
}

function findParties(lines) {
  let sender = labelledParty(lines, FROM_LABEL);
  let receiver = labelledParty(lines, TO_LABEL);
  if (sender && receiver) return { sender, receiver };

  // Unlabelled layout (e.g. K PLUS): name / bank / account, twice — the first
  // block is the sender, the second the receiver. Find each block's name from
  // its account line, or from title-prefixed names when accounts are missing.
  const nameIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isAccount(lines[i])) continue;
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      if (isNameCandidate(lines[j])) {
        if (!nameIdx.includes(j)) nameIdx.push(j);
        break;
      }
    }
  }
  if (nameIdx.length < 2) {
    lines.forEach((l, i) => {
      if (TITLE_RE.test(l) && !nameIdx.includes(i)) nameIdx.push(i);
    });
    nameIdx.sort((a, b) => a - b);
  }
  const blocks = nameIdx.map((i) => partyAt(lines, i));
  // Receiver labelled but sender not (SCB without "จาก"): the first block
  // above the receiver's label is the sender.
  const toIdx = lines.findIndex((l) => TO_LABEL.test(l));
  if (!sender && receiver && toIdx > 0) {
    const before = nameIdx.filter((i) => i < toIdx);
    if (before.length) sender = partyAt(lines, before[0]);
  }
  sender ??= blocks.length >= 2 ? blocks[0] : null;
  receiver ??= blocks.length >= 2 ? blocks[1] : blocks[0] ?? null;
  if (sender && receiver && sender.name === receiver.name) sender = null;
  return { sender, receiver };
}

// ---- Memo ------------------------------------------------------------------
const NOTE_LABEL = /^(บันทึกช่วยจำ|บันทึก|หมายเหตุ|ข้อความ|note|memo)\s*[:：]?\s*/i;
function findNotes(lines) {
  const i = lines.findIndex((l) => NOTE_LABEL.test(l));
  if (i < 0) return null;
  const rest = lines[i].replace(NOTE_LABEL, "").trim();
  if (rest) return rest;
  const next = lines[i + 1]?.trim();
  return next && !NOISE_RE.test(next) && !isAccount(next) ? next : null;
}

export function parseSlipText(text) {
  const lines = toArabic(String(text ?? ""))
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const { sender, receiver } = findParties(lines);
  return {
    paid_at: findDate(lines),
    receiver: receiver?.name ?? null,
    amount: findAmount(lines),
    notes: findNotes(lines),
    sender: sender?.name || sender?.account ? sender : null,
  };
}
