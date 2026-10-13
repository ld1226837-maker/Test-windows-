/// <reference types="node" />
// Vitest global setup: run every test in India Standard Time.
//
// The app deliberately computes business dates in IST (UTC+5:30, see
// localDateStr in src/lib/utils.ts), while many tests build times from
// local-clock strings such as new Date("2026-10-10T02:00:00"). On a UTC CI
// runner those two disagree, so IST-dependent tests failed there but passed on
// an Indian-timezone laptop. Pinning the zone here makes the suite behave the
// same on every machine. (CI also sets TZ in .github/workflows/ci.yml.)
export function setup() {
  process.env["TZ"] = "Asia/Kolkata";
}
