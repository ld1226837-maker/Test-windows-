/** File-name-safe text: whitespace becomes '-' and every character Windows /
 * Android reject in a file name (\\ / : * ? ' < > | and control characters)
 * is dropped, so a customer called 'A/B: Test' can't produce a path or a
 * failed save. */
export const safeFilePart = (value: string, fallback = "receipt") => {
  const cleaned = String(value ?? "")
    // Characters Windows/Android reject, plus control characters (filtered by
    // code point so the pattern itself holds no literal control characters).
    .replace(/[\\/:*?"<>|]/g, "")
    .split("")
    .filter((ch) => ch.charCodeAt(0) >= 32)
    .join("")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return cleaned || fallback;
};
