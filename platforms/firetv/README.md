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
- `canAlertOverApps(): boolean` — whether HomeGuard is on (see below)
- `watchAgents(config: string): void` — hands HomeGuard the T3 Code pairing
  and the alert's words as JSON; an empty string once unpaired. The shell
  saves it even while HomeGuard is off

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

## Staying in Luma

Fire OS won't accept a replacement home screen: Home always opens Amazon's
launcher, and most apps exit to it. The APK includes an accessibility service,
`app.luma.firetv.HomeGuard`, that watches window changes of
`com.amazon.tv.launcher` and brings Luma back whenever its home screen
appears. Other launcher screens, such as voice search results, stay. It also
opens Luma after a reboot, because enabled services start with the system.
It runs in its own `:guard` process so the low-memory killer can take the
WebView without taking the service along.

Enable it once over ADB (Fire OS 7 has no toggle for side-loaded services):

```sh
adb shell settings put secure enabled_accessibility_services \
  com.luma.launcher/app.luma.firetv.HomeGuard
adb shell settings put secure accessibility_enabled 1
```

That command replaces the list of enabled services; check
`adb shell settings get secure enabled_accessibility_services` first if
others are in use. To turn it off, set the list to `'""'`.

**Pin Luma to the Fire TV home bar** (Your apps → select Luma → Menu →
Move to front). After Home, Android blocks background activity starts for
about five seconds, but the foreground app is exempt; with Luma pinned, the
service clicks its tile and Amazon's launcher opens Luma itself.

- Backing out of an app returns to Luma immediately.
- Home reaches Luma in about 2.5–4 seconds when pinned (five otherwise). The
  service can only react once Amazon's home draws: Android 9 handles Home
  before accessibility key filters, and Fire OS keeps the `homekey` broadcast
  to its own apps. Until Luma is back, an overlay in Luma's colours hides
  Amazon's home and swallows remote keys.
- While the service is on, Back on Luma's home screen stays in Luma instead
  of parking the task. Fire TV Settings is a separate app and still opens
  from the Home long-press menu.

## Agent alerts

When a T3 Code agent newly needs you, a toast shows in the top-right corner
for six seconds: inside Luma when it's in front, and over any other app
otherwise, video included. HomeGuard draws the latter in an accessibility
overlay window that takes no focus, keys or touches, so the app underneath
keeps the remote and keeps playing.

Luma's page can't watch agents from behind another app: Chromium throttles a
hidden page's timers to once a minute and freezes it after a few minutes,
and the low-memory killer takes the WebView process (about 105 MB with its
renderer) as soon as it drops to a cached app. So HomeGuard keeps its own
small connection (`AgentWatch`: a WebSocket client for the shell stream
only, about 10 MB more in `:guard`), with the pairing the page hands over. It
alerts once per request, and remembers which across restarts for as long as
the request is pending. Several alerts at once show one after another. While
Luma is in front, it passes the alert to the page, which shows the same toast
unless the agents page already shows that agent.

Force-stopping Luma also turns HomeGuard off (Android removes it from the
enabled services); enable it again with the commands above.

## TODO

- [x] Return to Luma from apps, Home and boot (`HomeGuard`)
- [x] WebView shell project (Java, `platforms/firetv/android/`)
- [x] `adb connect <stick-ip> && adb install` deployment
