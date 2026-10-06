# Repo metadata — Android app

Paste these straight into the GitHub repo's "General" and "About" settings.

## Repository

- **Repo name (slug)**: `truff-bookings-sales-management-android`
- **Display name in README**: Truff Bookings & Sales Management — Android
- **Visibility**: Public
- **About → Description** (GitHub's field, ~350 char limit):
  > Offline-first turf booking & snack sales ledger for Android. Bookings, GST billing, customer dues, encrypted backups and day-close reports — built with Tauri v2 (mobile), React 19 and TanStack. No server, all data stays on-device.
- **About → Website**: (leave blank, or link the Windows repo once both are live)
- **About → Topics** (up to 20):
  `tauri` `android` `mobile-app` `react` `typescript` `tanstack-router`
  `tanstack-query` `dexie` `indexeddb` `offline-first` `point-of-sale`
  `billing` `gst` `sales-management` `booking-system` `apk`
  `receipt-printing` `rust`

## License — decide this before making the repo public

Same considerations as the Windows repo — see
`APP-PROFESSIONAL-ANALYSIS.md` §6 and the Windows repo's `REPO-SETUP.md`
for the option table. Keep both repos' license choice consistent, since
they share the same `src/lib` business logic and license-activation system.

## Secrets required for the release pipeline

Unlike the Windows pipeline, this one **cannot produce an installable
release build without secrets** — Android requires every release APK/AAB
to be cryptographically signed before it will install outside `dev` mode.

1. Generate a release keystore once, locally (never commit this file):
   ```bash
   keytool -genkeypair -v -keystore release.jks -keyalg RSA -keysize 2048 \
     -validity 10000 -alias truff-ledger
   ```
2. Add these as repo secrets (Settings → Secrets and variables → Actions):

   | Secret                      | Value                                       |
   | --------------------------- | ------------------------------------------- |
   | `ANDROID_KEYSTORE_BASE64`   | `base64 -w0 release.jks` output             |
   | `ANDROID_KEYSTORE_PASSWORD` | the keystore password you set above         |
   | `ANDROID_KEY_ALIAS`         | `truff-ledger` (or whatever alias you used) |
   | `ANDROID_KEY_PASSWORD`      | the key password you set above              |

Without these four secrets, `release-android.yml` will build and attach
**debug** APKs to the GitHub Release instead (clearly labeled as such) so
the pipeline never fails outright for a missing keystore — it degrades.

## Play Store note

This pipeline produces a signed `.apk` (direct-install / GitHub Release)
and, when secrets are present, a signed `.aab` (the format the Play
Store requires). The `.aab` is uploaded as a release asset but **is not
auto-submitted to the Play Store** — that needs a separate Google Play
Console service-account step this workflow deliberately doesn't attempt,
since it requires your Play Console credentials and an existing store
listing. Add a `fastlane`/`r0adkll/upload-google-play` step later if you
want that automated too.

## First run — one thing to verify manually

`src-tauri/gen/android/` is not committed to this repo (see
`ANDROID_BUILD.md` — it's regenerated fresh by `tauri android init` on
every CI run, which is the correct pattern for Tauri mobile projects).
That means the exact Gradle signing-config property names the workflow
writes into `keystore.properties` are asserted, not yet confirmed against
a real generated `build.gradle.kts` from this Tauri CLI version. **The
first real run of this workflow is the point where you should open the
job log and confirm the signing step actually found and used the
keystore** (Gradle prints the signing config it used during the `assemble`
task) — the workflow comments flag exactly where to look if it doesn't.

## Cutting a release

```bash
git tag v0.2.0
git push origin v0.2.0
```

The workflow builds, signs (if secrets are present), checksums, and
attaches everything to a GitHub Release created from the tag.
