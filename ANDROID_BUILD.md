# Building this app for Android (via Tauri)

> **Don't want to install the Android SDK/NDK/Rust yourself?** Skip to
> [Building via GitHub Actions](#building-via-github-actions-recommended) below —
> it builds the APK in the cloud every time you push, no local setup required.

This project is already set up for Tauri v2 desktop builds (`src-tauri/`), and the
frontend is built in SPA mode (`vite.config.ts` → `tanstackStart.spa.enabled`) with
all data stored locally (Dexie/localStorage). That means it needs no backend server
at runtime — which is exactly what Tauri's Android target needs too. So instead of
adding a second toolchain (e.g. Capacitor), we extend the _same_ Tauri config to
also produce an Android build.

You cannot build this from a browser or a sandboxed AI environment — it needs the
Android SDK/NDK, a Rust toolchain, and Gradle installed locally. Below is the exact
path to get a `.apk` on your own machine.

## 1. One-time setup

Install, in this order:

1. **Node.js** (already required for this project) + your package manager (`npm`/`bun`).
2. **Rust**, via [rustup.rs](https://rustup.rs).
3. Add the Android targets to Rust:
   ```sh
   rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
   ```
4. **Android Studio**, then inside it (Settings → Android SDK):
   - Android SDK Platform (latest)
   - Android SDK Platform-Tools
   - Android SDK Build-Tools
   - NDK (Side by side)
   - Android SDK Command-line Tools
5. Set environment variables (adjust paths for your OS):
   ```sh
   export JAVA_HOME=/path/to/Android/Studio/jbr        # or your JDK
   export ANDROID_HOME=$HOME/Android/Sdk               # ~/Library/Android/sdk on macOS
   export NDK_HOME=$ANDROID_HOME/ndk/<version>
   ```
6. Install the Tauri CLI (if not already a project dependency):
   ```sh
   cargo install tauri-cli --version "^2.0.0"
   # or: npm i -D @tauri-apps/cli
   ```

## 2. Initialize the Android project

From the project root:

```sh
npm install          # or: bun install
npm run tauri android init
```

This generates `src-tauri/gen/android/` — a full Android Studio/Gradle project
wired to your Rust code. It's generated, not hand-written, so don't commit it
unless you plan to customize the native side directly.

## 3. (Optional) App icons

Tauri can regenerate all platform icon sizes from one source image:

```sh
npm run tauri icon path/to/your/icon.png
```

## 4. Dev / test on a device or emulator

```sh
npm run tauri android dev
```

This launches the app with live reload on a connected device or running emulator.

## 5. Build a release APK

```sh
npm run tauri android build -- --apk
```

The **unsigned** APK will be under:

```
src-tauri/gen/android/app/build/outputs/apk/universal/release/
```

For a Play Store upload, build an AAB instead:

```sh
npm run tauri android build -- --aab
```

## 6. Sign the release build

Android requires every release build to be signed before it can be installed
outside of `dev` mode.

```sh
keytool -genkeypair -v \
  -keystore release-key.jks \
  -alias release \
  -keyalg RSA -keysize 2048 -validity 10000
```

Then either sign with `apksigner` directly:

```sh
$ANDROID_HOME/build-tools/<version>/apksigner sign \
  --ks release-key.jks \
  src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
```

...or (recommended) configure signing so `tauri android build` signs it for you,
by setting these environment variables before the build:

```sh
ANDROID_SIGNING_STORE_FILE=/absolute/path/to/release-key.jks
ANDROID_SIGNING_STORE_PASSWORD=your-store-password
ANDROID_SIGNING_KEY_ALIAS=release
ANDROID_SIGNING_KEY_PASSWORD=your-key-password
```

**Keep `release-key.jks` and its passwords safe and out of git.** Every update
to the app on the Play Store must be signed with the same key, forever.

## Notes specific to this project

- `tauri.conf.json`'s `identifier` is `com.turfledger.app`, shared across
  desktop and Android so both platforms stay under one identity. It used to
  be `com.turfledger.desktop` — a leftover from when this config only
  targeted the Windows build, and an odd fit for an Android/Play Store
  package name — and was changed to the neutral `.app` suffix. No real
  Android build has ever run against this repo (no Rust/Android toolchain
  in the sandbox that made this change), so there was no Play Store
  continuity to protect yet; if a real build has since shipped under the
  old identifier by the time you read this, treat this change as reverted
  and keep whatever is already live instead.
- The minimum supported Android version for Tauri apps is Android 7.0 (SDK 24). To
  raise it, add to `tauri.conf.json`:
  ```json
  { "bundle": { "android": { "minSdkVersion": 24 } } }
  ```
- Since the app is fully client-side (Dexie/localStorage), there's nothing extra to
  configure for offline use — it already works that way in the desktop Tauri build.
- Windows desktop bundling (`nsis`, `msi` in `tauri.conf.json`) is untouched by any
  of the above — Android is a separate build target alongside it, not a replacement.

## Building via GitHub Actions (recommended)

This project includes `.github/workflows/android-build.yml`, which builds the
APK on GitHub's own servers — you don't need Android Studio, Rust, or any SDKs
on your own machine. It's the easiest way to go from this source code to an
installable `.apk`.

### One-time setup

1. **Create a GitHub repository** (if you haven't already) and push this
   project to it:
   ```sh
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```
2. That's it — no extra configuration is required for an **unsigned** debug-style
   build. The workflow is already in the repo.

### Running the build

- Every push to `main` that touches `src/`, `src-tauri/`, or `package.json`
  triggers the build automatically, **or**
- Go to your repo on GitHub → **Actions** tab → **Build Android APK** →
  **Run workflow** to trigger it manually any time.

The build takes several minutes (it installs the Android SDK/NDK and Rust
toolchain fresh each run, then compiles). When it finishes:

1. Open the completed run under the **Actions** tab.
2. Scroll to **Artifacts** at the bottom of the run summary.
3. Download **`truff-snacks-android-apks`** — this is a zip containing four
   `.apk` files, one per architecture (arm64-v8a, armeabi-v7a, x86, x86_64).
   Unzip it and install the one matching your device (arm64-v8a covers
   almost all phones from the last several years) — you'll need to allow
   "install from unknown sources" for an unsigned APK, since it isn't signed
   with a Play Store key.

### Signing the build (optional, needed for the Play Store)

By default the workflow produces an **unsigned** APK, which is fine for
sideloading onto your own device but not for Play Store distribution. To get
a signed build:

1. Generate a keystore once, locally:
   ```sh
   keytool -genkeypair -v -keystore release-key.jks -alias release \
     -keyalg RSA -keysize 2048 -validity 10000
   ```
2. Base64-encode it:
   ```sh
   base64 -i release-key.jks | tr -d '\n'
   ```
3. In your GitHub repo, go to **Settings → Secrets and variables → Actions →
   New repository secret** and add these four secrets:
   - `ANDROID_KEYSTORE_BASE64` — the base64 string from step 2
   - `ANDROID_KEYSTORE_PASSWORD` — your keystore password
   - `ANDROID_KEY_ALIAS` — the alias you used (`release` in the example above)
   - `ANDROID_KEY_PASSWORD` — your key password
4. Re-run the workflow. It will detect the secrets, decode the keystore, and
   produce a signed APK automatically.

**Keep `release-key.jks` and its passwords safe and never commit them to the
repo.** Every future update to the app must be signed with the same key.

### Multi-platform note

This same GitHub repo can also drive your **desktop** builds (Windows via
`nsis`/`msi`, already configured in `tauri.conf.json`) — you'd add a sibling
workflow (e.g. `windows-build.yml` or `desktop-build.yml`) running
`npm run tauri build` on a `windows-latest` runner, following the same pattern
as `android-build.yml`. Ask if you'd like that workflow added too.
