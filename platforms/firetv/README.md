# Android TV / Fire TV

Target: Android TV and Fire TV sticks. Luma is the same native Rust launcher as on
webOS, built as SDL's `libmain.so` for 32-bit ARM (`armeabi-v7a`) and run by an
`SDLActivity` in a small APK.

## How it fits together

- `native/` is a Cargo package whose library is `../../../src/main.rs`, built as a
  `cdylib` named `main`. It's its own workspace, so the root workspace and lock file
  stay upstream's. Its dependencies match the root package, and `build.mjs` checks
  that both use the same version.
- `src/android.rs` (compiled for Android only) is SDL's `SDL_main`. It sends Luma's
  stderr to logcat under the tag `luma`, traps Back so Luma owns the Back stack, and
  answers the platform worker's requests through JNI on `MainActivity`:
  - `listApps(): String`, JSON `{ "apps": [{ "id": string, "title": string }] }`.
    App ids are Android package names. Amazon's own tools and storefronts are left
    out, except Prime Video and YouTube.
  - `launchApp(id: String): String`, JSON `{ "error"?: string }`. Each launch
    resolves the leanback-preferred launchable activity through PackageManager.
  - `openSettings(): String`. The Fire TV settings row in Settings → System
    launches webOS's `com.palm.app.settings`, which Android answers with this. Fire OS answers
    Android's standard Settings intent with an empty stub, so the shell starts
    Amazon's `com.amazon.tv.launcher/.ui.MainSettingsActivity` and falls back to
    the standard intent on other Android TV devices.
- Everything else is the desktop build: inputs, recents and uninstall are webOS-only
  and stay hidden or empty, and the public update check is off because the release
  feed carries webOS packages.
- Fire TV brands use their package names (`ANDROID_APPS` in `src/branding.rs`). Other
  apps show their own TV banner or icon, which `Shell.art()` draws and Luma reads
  through `appArt(id): byte[]`.
- `MainActivity` copies the APK's `assets/luma` (the `.build/assets` tree) to app
  storage once per installed build, about 2.5 seconds on a Fire TV Stick Lite, and
  passes `--assets`, `--preferences` and `--fullscreen` to Luma. Preferences are
  `files/preferences.json`; the web launcher's localStorage isn't migrated.
- The remote's D-pad arrives as arrow keys. OK is `DPAD_CENTER`, which SDL maps to
  Select and `src/sdl_events.rs` turns into Enter.

## Packaging

One-time prerequisites:

- Node 22+ and `pnpm install` at the repo root, plus `pnpm assets` (see
  [development.md](../../development.md)).
- An Android SDK with build-tools 34+, a platform (android-34+), an NDK and CMake:
  `sdkmanager "build-tools;35.0.0" "platforms;android-34" "ndk;27.1.12297006" "cmake;3.22.1"`,
  then `export ANDROID_HOME=…`.
- `rustup target add armv7-linux-androideabi`, `pkg-config`, and a JDK (17–21
  recommended).

```sh
pnpm assets && node platforms/firetv/build.mjs
```

produces **`platforms/firetv/luma.apk`**, without Gradle. The script downloads the
SDL 2.30.12 source (the release upstream pins for webOS, checked by SHA-256) into
`.build/firetv`, builds `libSDL2.so` with the SDK's CMake, cross-compiles
`libmain.so`, then runs `aapt2`, `javac --release 8` (the shell and SDL's own Java
classes), `d8`, `zip`, `zipalign` and `apksigner`.

The debug keystore `keystore/debug.jks` (alias `luma`, password `android`) is
gitignored. Keep it: an APK signed with another key won't install over the existing
app, and uninstalling first wipes Luma's preferences.

## Install

On the stick: Settings → My Fire TV → Developer Options → **ADB Debugging** and
**Apps from Unknown Sources**, and note the IP under Settings → About.

```sh
adb connect <stick-ip>          # port 5555 by default
adb install -r platforms/firetv/luma.apk
adb logcat -s luma              # Luma's own output
```

## Staying in Luma

Fire OS won't accept a replacement home screen: Home always opens Amazon's launcher,
and most apps exit to it. The APK includes an accessibility service,
`app.luma.firetv.HomeGuard`, that watches window changes of `com.amazon.tv.launcher`
and brings Luma back whenever its home screen appears. Other launcher screens, such
as voice search results and Settings, stay. It also opens Luma after a reboot,
because enabled services start with the system. It runs in its own `:guard` process
so the low-memory killer can take Luma without taking the service along.

Enable it once over ADB (Fire OS 7 has no toggle for side-loaded services):

```sh
adb shell settings put secure enabled_accessibility_services \
  com.luma.launcher/app.luma.firetv.HomeGuard
adb shell settings put secure accessibility_enabled 1
```

That command replaces the list of enabled services; check
`adb shell settings get secure enabled_accessibility_services` first if others are
in use. To turn it off, set the list to `'""'`.

**Pin Luma to the Fire TV home bar** (Your apps → select Luma → Menu → Move to
front). After Home, Android blocks background activity starts for about five
seconds, but the foreground app is exempt; with Luma pinned, the service clicks its
tile and Amazon's launcher opens Luma itself.

- Backing out of an app returns to Luma immediately.
- Home reaches Luma in about 2.5–4 seconds when pinned (five otherwise). The service
  can only react once Amazon's home draws: Android 9 handles Home before
  accessibility key filters, and Fire OS keeps the `homekey` broadcast to its own
  apps. Until Luma is back, an overlay in Luma's colours hides Amazon's home and
  swallows remote keys.

## Agent alerts

When a T3 Code agent newly needs you, HomeGuard shows a toast in the top-right
corner for six seconds, over any app and over Luma, video included. Luma draws its
own toasts on other platforms and leaves them to HomeGuard here. HomeGuard draws it in
an accessibility overlay window that takes no focus, keys or touches, so the app
underneath keeps the remote and keeps playing.

HomeGuard keeps its own small connection (`AgentWatch`: a WebSocket client for the
shell stream only) with the pairing saved in its preferences. It alerts once per
request, and remembers which across restarts for as long as the request is pending
(`files/agent-alerts-seen.json`). Several alerts at once show one after another, and
an alert whose request ends first, say because it was answered elsewhere, is
dropped.

The T3 Code tile opens the agents page, which pairs Luma with T3 Code and hands the pairing to HomeGuard
(`watchAgents`), so alerts follow it, and an unpair clears HomeGuard's copy. On a stick
that HomeGuard already watched for the web launcher, Luma carries that pairing over on
first start.

## Agents inbox

The remote's Menu key opens the agents inbox on any Luma page. In another app,
HomeGuard filters Menu (the only key it filters), brings Luma forward with
`app.luma.firetv.OPEN_INBOX`, and Luma opens the inbox; closing it with Back or Menu
calls `returnToApp`, which moves Luma's task behind that app again. The app stops
while Luma is in front, so a video pauses there. OK on an agent opens its thread in
T3 Code's web app.

## T3 Code's web app

Open on an agent shows its thread in T3 Code's own web app (`WebAppActivity`, with
`assets/t3/tv.{css,js}` injected for the remote). Luma mints a one-time code with its
token for the server's `/pair` page, then goes on to the thread, and remembers which
origin already has a session (`files/t3-web-origin`). If the web app's session is gone,
tv.js calls `LumaWeb.repair()`: MainActivity keeps the target, and Luma pairs it again
and reopens it, at most once in 30 seconds.

Force-stopping Luma also turns HomeGuard off (Android removes it from the enabled
services); enable it again with the commands above.

## Not yet native

- Luma's own conversation view; Open uses T3 Code's web app.
