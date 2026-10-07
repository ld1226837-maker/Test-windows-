/**
 * Canonical phone key used ONLY for sorting/search-independent ordering.
 *
 * The app stores Indian customer numbers as 10 digits, but imported/legacy
 * data can contain +91, 0091, a leading 0, spaces, dashes, brackets, or
 * Unicode decimal digits. For a reliable contact-number sort we normalize all
 * of those representations to the last 10 digits when at least 10 digits are
 * present. Shorter values are kept as-is instead of being silently changed.
 */
export function normalizePhoneSortKey(
  value: string | null | undefined,
): string {
  if (!value) return "";

  const ascii = value
    .replace(/\p{Nd}/gu, (d) => {
      const cp = d.codePointAt(0)!;
      const ranges = [0x0660, 0x06f0, 0x0966, 0x0be6, 0x0c66, 0x0ce6, 0x0d66];
      const base = ranges.find((start) => cp >= start && cp <= start + 9);
      return base === undefined ? d : String(cp - base);
    })
    .replace(/\D/g, "");

  if (!ascii) return "";
  return ascii.length >= 10 ? ascii.slice(-10) : ascii;
}

export function comparePhoneForSort(
  a: string | null | undefined,
  b: string | null | undefined,
  dir: "asc" | "desc" = "asc",
): number {
  const da = normalizePhoneSortKey(a);
  const db = normalizePhoneSortKey(b);

  // Empty/invalid numbers always remain at the bottom, regardless of direction.
  if (!da && !db) return 0;
  if (!da) return 1;
  if (!db) return -1;

  // Numeric comparison without Number()/parseInt(), so there is no precision
  // loss and the comparator remains correct for arbitrary digit lengths.
  const cmp =
    da.length !== db.length
      ? da.length - db.length
      : da < db
        ? -1
        : da > db
          ? 1
          : 0;
  return dir === "asc" ? cmp : -cmp;
}
