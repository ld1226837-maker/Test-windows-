# Vitest fixes — 2026-10-03

Applied to this v3 tree:

- `src/lib/migration-fixes.test.ts`: added `// @vitest-environment jsdom` because the suite directly uses `window.localStorage`.
- `src/lib/teams-merge.test.ts`: added `import "fake-indexeddb/auto";` because the suite uses the Dexie `db` directly and otherwise has no IndexedDB implementation.

These are test-environment corrections; production behavior was not weakened to make tests pass.

The supplied v3 verification report records that the full suite was still failing (about 65–66 failures per tree) and attributes the remaining failures to stale fixtures, rejected orphan/partial data, environment issues, timeouts, and memory thresholds. A fresh full Vitest run could not be completed in this sandbox because the archive's dependencies were not fully installed and the package registry installation timed out.
