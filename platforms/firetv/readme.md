# Android TV / Fire TV

Target: Android TV and Fire TV sticks. Luma runs in a thin WebView APK shell.

## Bridge

`packages/bridge/src/android.ts` talks to the shell through
`window.LumaAndroid` with three synchronous calls:

- `isTV(): boolean`
- `listApps(): string` — JSON `{ "apps": [{ "id": string, "title": string }] }`
- `launchApp(appId: string): string` — JSON `{ "error"?: string }`
- `exit(): void`

The shell enumerates installed launchable activities via PackageManager and
starts them with `startActivity`. No permissions beyond internet are needed.

## Home button

Launcher Manager / Wolf Launcher can route the Home key to Luma, giving a
launcher feel that Tizen and stock Android TV don't allow.

## TODO

- [ ] WebView shell project (Kotlin, `apps/firetv/`)
- [ ] Boot autostart via `RECEIVE_BOOT_COMPLETED` + Launcher Manager
- [ ] `adb connect <stick-ip> && adb install` deploy script
