# Truff Bookings & Sales Management — Professional Analysis

Scope: analysis of the two uploaded codebases (`truff-ledger-windows-main`,
`truff-ledger-android-main`) as they stand today, written for use as a repo
`ARCHITECTURE.md` / due-diligence document, or as the basis for a store
listing / investor-facing one-pager.

## 1. What the product is

A local-first, offline point-of-sale and ledger app for a combined **turf
(sports-ground) booking + snacks/canteen** business in India. One React 19 +
TanStack codebase is shipped as two native shells: a Windows desktop app and
an Android app, both via **Tauri v2** (not Electron, not Capacitor) — so the
web layer, business logic, and UI are byte-identical across platforms, and
only the native shell (window chrome vs. touch chrome, keyring vs. no
keyring, NSIS installer vs. APK/AAB) differs.

**Core capabilities**, as implemented:

- Turf bookings: multi-court slots, day-part rates, repeat bookings,
  advances, split cash/UPI/card payments, cancellations with
  forfeited/refundable advance handling
- Snack sales: live stock, combos, tax-frozen bills at time of sale
- Customer ledger: running dues, on-tab sales, "settle all" across every
  open booking/bill/tab for a customer in one action
- GST invoicing (CGST/SGST + custom taxes), PDF/print/share receipts, UPI QR
  on receipts
- Reports: revenue, collections, dues, profit, payment-mode split, GST,
  P&L, Excel exports
- Encrypted local backup (AES-256-GCM) + optional Telegram cloud backup,
  with a restore preview and confirmation step before any data-changing
  restore
- Day-close cash drawer with variance tracking and re-close history
- Role-based access (Admin/Staff), local username+password auth, admin-only
  gating of Dashboard/Reports
- Device-bound, Ed25519-signed license activation and a ₹599/month
  subscription flow for the Indian market

## 2. Architecture

- **Frontend**: React 19, TanStack Start/Router, TanStack Query, Tailwind
  CSS v4, shadcn/Radix primitives, `react-hook-form` + `zod`
- **Local data**: Dexie (IndexedDB) — no server, no SQLite; all business
  data lives on-device
- **Native shell**: Tauri v2 (Rust) — `src-tauri/` handles OS keyring access
  (Windows Credential Manager / Keychain), filesystem, native dialogs, and
  an Android-specific save plugin (`plugins/android-save`)
- **Build**: Vite, built in SPA mode so the same static output is servable
  from either shell with no backend process at runtime
- **Shared-domain integrity**: the two platform repos are _not_ a monorepo
  — they're separate checkouts kept in sync deliberately. A
  `shared-domain-manifest.json` (SHA-256 per shared file) plus
  `scripts/verify-shared-parity.mjs` gives a checkable guarantee that
  `src/lib` business logic (money math, dues, analytics, settings, local DB
  schema) stays byte-identical between the Windows and Android trees,
  without physically merging the folders.

## 3. Code health signals

- 244 TypeScript/TSX files, ~68k lines in `src/` (Windows tree)
- Test suite: 625/625 passing (Windows), 559/559 (Android) as of the most
  recent verified run; `tsc --noEmit` and `eslint` both clean on both trees
- A dedicated `verify:seeders` step runs seeded financial fixtures
  (4,920 / 7,935 / 12,855-row scenarios) plus an independent load-test ledger
  audit — i.e. money math is checked against fixtures, not just unit-tested
  in isolation
- `docs/calculation-rules.md` documents the money rules as the single
  source of truth, with an explicit instruction to read it before touching
  `src/lib`
- An ongoing structured audit ("Truff Master Audit", findings F1–F120+)
  has been fixing atomicity bugs (non-atomic multi-table operations wrapped
  in `db.transaction`, defense-in-depth guards on destructive operations
  like year-archiving) as they're found, with regression tests added
  per fix

## 4. Security posture

- Backups are encrypted (AES-256-GCM) before they leave the device,
  including the year-archive `.db` export (a real cleartext-on-disk bug in
  the archiver was found and fixed — see CHANGELOG)
- Telegram backup path uses a bot token, stored in the OS keyring on
  Windows (not available on Android — guarded by a `target_os` check in
  Rust, worth confirming what the Android equivalent is before publishing)
- License activation uses Ed25519 signing with an offline generator tool,
  device-bound to prevent unauthorized copy/reuse
- Windows CSP is tightly scoped (`default-src 'self'` plus a small
  allowlist for fonts/telemetry); Android's CSP additionally allows
  `asset:`/`ipc:` schemes Tauri's Android webview needs

## 5. What's genuinely unfinished (worth stating publicly, not hiding)

Per the project's own tracking notes:

- No signed Android release build yet — CI currently produces **debug**
  APKs only (self-signed with Android's default debug key); a signed
  release AAB/APK needs a keystore wired in (this analysis's paired
  workflow file addresses exactly this gap)
- `src-tauri/gen/android/` is not committed — it's regenerated on every CI
  run via `tauri android init`, which is the correct pattern for Tauri
  mobile, but means the generated Gradle project has not been hand-verified
  outside CI
- Manual click-through QA of the last several UX-restructure steps is still
  outstanding
- Accessibility audit, receipt-template variety (Counter/Detailed/Payment/
  Customer statement), and release code-signing (Windows Authenticode /
  Android Play signing) are explicitly listed as not yet done

## 6. Before publishing this publicly — the one decision that matters

This app has a **paid license-activation and subscription system** built
in. Publishing the full source under a permissive license (MIT/Apache-2.0)
would legally allow anyone to strip that gate and redistribute a
license-free build. That's very likely not the intent. See each repo's
`REPO-SETUP.md` for the licensing options and a recommended default before
you flip either repo to public.
