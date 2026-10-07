# Verification

Migration-critical source is shared with the Android build and the two copies are audited for byte parity.

Install dependencies from `package-lock.json` before running verification:

```bash
npm ci
npm run typecheck:all
npm run lint
npm test
npm run verify:seeders
```

`node_modules` is intentionally excluded from the release archive so a partial local dependency cache cannot mask verification failures.
