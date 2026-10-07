# Update strategy — Android

Status: not implemented, same posture as `docs/release-signing.md`'s
Windows counterpart — this is a decision guide, not code, since which
route applies depends on how the app is actually going to be distributed,
which hasn't been decided yet.

## Two real options, and they're quite different

**Play Store distribution.** If the signed AAB/APK from
`ANDROID_BUILD.md` ends up published to the Play Store, updates are
already solved — Play handles checking, downloading, and installing new
versions for every user automatically. No code needed in this repo at
all. This is the simple option, but it means going through Play Console
review for every release, and the `com.turfledger.app` identifier
(Step 43) then becomes effectively permanent — Play ties an app's listing
to its package name.

**Direct APK distribution** (sideloading — installing the signed APK
outside the Play Store, e.g. shared the same way `TelegramBackupCard.tsx`
already shares backups). Android has no built-in update mechanism for
this path; two ways to cover it:

- _Manual_: whoever installs the app re-downloads and re-installs the
  APK by hand when a new version is available, with no in-app prompt.
  Zero code, but relies on someone remembering to check.
- _In-app version check_: the app periodically fetches a small JSON
  file (`{"version": "1.2.0", "notes": "...", "url": "..."}`) from a URL
  you control, compares it to its own version, and shows a banner if a
  newer one exists — similar in shape to `AppStatusStrip.tsx`'s existing
  backup-age indicator. This only _notifies_; actually installing a new
  APK over an old one still needs the `REQUEST_INSTALL_PACKAGES`
  permission and a user tap through Android's "install unknown apps"
  flow — Android does not let an app silently replace itself the way
  Tauri's desktop updater can.

Like the Windows doc's manifest, a version-check JSON file needs
somewhere to live. Nothing in this repo currently hosts one — the point
of this doc is that "where releases live" needs deciding before either
of the sideload sub-options is worth building, not that either is
technically hard.

## Why nothing was wired up now

An in-app version check is genuinely simple to build once a hosting
answer exists (fetch + string/semver compare + a banner — no different
in kind from the online/offline check `AppStatusStrip.tsx` already does).
It wasn't built speculatively against a guessed URL because getting that
wrong would ship a permanently-pointed-nowhere check, which is worse than
not having one — same reasoning as the Windows updater doc.

## Recommendation, if one's wanted

Play Store is the lower-maintenance choice for something a small number
of people install and expect to "just update," and it removes needing to
build or maintain the in-app check at all. Direct APK distribution only
becomes the better fit if there's a reason to stay off the Play Store
(no developer account, avoiding review turnaround, distributing to a
closed group). This is genuinely a call about how the app reaches people,
not a technical one — worth deciding alongside the identifier question
that Step 43 already settled, since both are one-way-ish decisions once
real users are on a version.
