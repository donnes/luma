# Android TV / Fire TV

Target: Android TV and Fire TV sticks. Luma runs in a thin WebView APK shell.

## Bridge

`packages/bridge/src/android.ts` talks to the shell through
`window.LumaAndroid`, injected with `addJavascriptInterface`; every method is
a synchronous JSON call:

- `isTV(): boolean`
- `listApps(): string` — JSON `{ "apps": [{ "id": string, "title": string }] }`
- `launchApp(appId: string): string` — JSON `{ "error"?: string }`
- `exit(): void`

The shell (`platforms/firetv/android/`) injects the object with
`addJavascriptInterface` and implements it as `app.luma.firetv.Shell`. App ids
are **Android package names** — on purpose, so they pass the shared
`validAppId` check (component names would contain `/`) and match the fixture
grid — and each launch resolves the leanback-preferred launchable activity
through PackageManager. No permissions beyond internet are needed.

## Shell behavior

- `dist/app` is shipped as APK assets and served from the synthetic origin
  `https://luma.local/` through `WebViewClient.shouldInterceptRequest`
  (`file://` cannot load subresources securely or keep CSP/localStorage
  semantics). Any other origin — the weather API — goes to the network.
- The Back key dispatches an `Escape` keydown into the app, which owns panel
  and page back-stacks. When the app has nothing to close,
  `platformBack()` reaches `exit()` and the shell calls `moveTaskToBack`
  instead of finishing: relaunching Luma is instant and the task survives.
- D-pad navigation and OK work as arrow/Enter key events, like a browser.
- The same APK installs on phones via its plain `LAUNCHER` filter; TVs show
  the leanback tile with `res/drawable/ic_banner.png`.

## Packaging

One-time prerequisites:

- Node 22+, `pnpm install` at the repo root.
- Android SDK with **build-tools 35** and a platform (android-33+), e.g.
  [cmdline-tools](https://developer.android.com/studio#command-line-tools-only):
  `sdkmanager "build-tools;35.0.0" "platforms;android-34"`, then
  `export ANDROID_HOME=…`.
- A JDK: 17–21 recommended. Newer JDKs work with build-tools 35's `d8`
  (build-tools 34's d8 fails on javac 27 output); if tooling complains, pin
  one: `mise x java@temurin-17 -- node platforms/firetv/build.mjs`.

```sh
pnpm build && node platforms/firetv/build.mjs
```

produces **`platforms/firetv/luma.apk`** — no Gradle. The script wires
together `aapt2` (manifest, launcher art generated from
`public/app-icon.svg`, and `dist/app` as `assets/app/`), `javac --release 8`,
`d8`, `zip`, `zipalign`, and `apksigner`. Signature v1+v2 keeps it installable
from Fire OS 5 onward.

The debug keystore `keystore/debug.jks` (alias `luma`, password `android`)
is committed on purpose: reinstalls keep the same app identity, and custom
favorites stored in the WebView's localStorage survive updates. Rebuilding a
release for other people? Bump `android:versionCode` in the manifest so
`adb install -r` accepts it.

## Install

On the stick: Settings → My Fire TV → Developer Options → **ADB Debugging**
and **Apps from Unknown Sources**, note the IP under Settings → About.

```sh
adb connect <stick-ip>          # port 5555 by default
adb install -r platforms/firetv/luma.apk
```

Afterward log in over the network at `adb logcat luma:V adb:d *:S` to watch
console output, and `adb shell monkey -p com.luma.launcher 1` to launch.

## Home button

Launcher Manager / Wolf Launcher can route the Home key to Luma, giving a
launcher feel that Tizen and stock Android TV don't allow. `exit()` parks the
task rather than finishing it, so Home-style relaunch times stay instant.

## TODO

- [ ] Boot autostart via `RECEIVE_BOOT_COMPLETED` + Launcher Manager
- [x] WebView shell project (Java, `platforms/firetv/android/`)
- [x] `adb connect <stick-ip> && adb install` deployment
