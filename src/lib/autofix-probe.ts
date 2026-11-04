// Temporary file to test the auto-fix workflow. Safe to delete.
export function autofixProbe(a: number, b: number) {
  const total = a + b;
  const label = "sum";
  return { label, total };
}
