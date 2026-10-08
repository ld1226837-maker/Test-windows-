/**
 * Phone-number normalisation for India (+91), with international numbers
 * passed through untouched. Pure (no imports) so it is trivially testable
 * and safe to use from any lib/component.
 *
 * Handles what people actually type or paste into a customer record:
 *   9876543210 · 98765 43210 · 98765-43210 · (98765) 43210
 *   09876543210 · 919876543210 · +91 98765 43210 · 0091 98765 43210
 *   044 2812 3456 / 4428123456 (Chennai landline) · +44 20 7946 0958
 * plus invisible direction marks / NBSP from contact pickers and
 * Devanagari / Tamil digits.
 */

export type PhoneKind = "mobile" | "landline" | "international";

export interface ParsedPhone {
  kind: PhoneKind;
  /** Digits only, with country code, no "+" — what wa.me needs. */
  digits: string;
  /** "+" + digits — what tel: wants. */
  e164: string;
  /** Human-readable, e.g. "+91 98765 43210". */
  display: string;
}

const INDIC_DIGIT_RANGES: Array<[number, number]> = [
  [0x0966, 0x096f], // Devanagari
  [0x0be6, 0x0bef], // Tamil
];

function toAsciiDigits(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const r = INDIC_DIGIT_RANGES.find(([a, b]) => cp >= a && cp <= b);
    out += r ? String(cp - r[0]) : ch;
  }
  return out;
}

function build(kind: PhoneKind, digits: string): ParsedPhone {
  let display = `+${digits}`;
  if (digits.startsWith("91") && digits.length === 12) {
    display = `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  return { kind, digits, e164: `+${digits}`, display };
}

/** Returns null when the value can't be a dialable number. */
export function parsePhone(raw?: string | null): ParsedPhone | null {
  if (raw == null) return null;
  // Strip zero-width / direction marks and NBSP, normalise digits.
  let s = toAsciiDigits(String(raw))
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/\u00a0/g, " ")
    .trim();
  if (!s) return null;
  // Drop a trailing extension ("x123", "ext 12") — can't dial it anyway.
  s = s.replace(/\s*(?:ext\.?|x|#)\s*\d+\s*$/i, "");

  const hasPlus = s.startsWith("+");
  let d = s.replace(/\D/g, "");
  if (!d) return null;

  // Explicit international prefix: "+CC…" or "00CC…".
  let international = hasPlus;
  if (!international && d.startsWith("00")) {
    d = d.slice(2);
    international = true;
  }
  if (international) {
    if (d.startsWith("91")) return indian(d.slice(2));
    if (d.length < 8 || d.length > 15) return null;
    return build("international", d);
  }

  // Indian formats without "+".
  if (d.length === 13 && d.startsWith("091")) return indian(d.slice(3));
  if (d.length === 12 && d.startsWith("91")) return indian(d.slice(2));
  if (d.length === 11 && d.startsWith("0")) return indian(d.slice(1));
  if (d.length === 10) return indian(d);
  return null;
}

/** `n` = national number WITHOUT the country code / trunk 0. */
function indian(n: string): ParsedPhone | null {
  if (n.length !== 10) return null;
  if (/^[6-9]/.test(n)) return build("mobile", `91${n}`);
  // STD code + subscriber number (e.g. Chennai 44 + 8 digits).
  if (/^[1-5]/.test(n)) return build("landline", `91${n}`);
  return null;
}

/** tel: URI, or null when the number is unusable. */
export function telUrl(raw?: string | null): string | null {
  const p = parsePhone(raw);
  return p ? `tel:${p.e164}` : null;
}

/**
 * WhatsApp number (digits + country code). Null for landlines and invalid
 * numbers — WhatsApp accounts need a mobile.
 */
export function whatsappNumber(raw?: string | null): string | null {
  const p = parsePhone(raw);
  if (!p || p.kind === "landline") return null;
  return p.digits;
}

export function waMeUrl(raw: string | null | undefined, text?: string): string {
  const to = whatsappNumber(raw) ?? "";
  return text
    ? `https://wa.me/${to}?text=${encodeURIComponent(text)}`
    : `https://wa.me/${to}`;
}
