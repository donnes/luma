# Tizen (Samsung TVs)

Target: Samsung Smart TVs 2015+ (Tizen 2.3 through 10). Luma runs as a Tizen
web application using only public `tizen.application` APIs — no rooting.

## Bridge

`packages/bridge/src/tizen.ts` implements the platform surface:

- `tizen.application.getAppsInfo()` for the app library
- `tizen.application.launch(id)` for app launches
- Back key handling through the app lifecycle

HDMI input switching is not available from a Tizen application; the bridge
reports a warning instead of a fake input list.

## Packaging

Build the web assets at the repo root with `pnpm build`, then run
`node platforms/tizen/package.mjs` to produce `dist/com.luma.launcher.wgt`
(placeholder config: set the certificate and device ID at install time with
Tizen Studio's certificate manager and `sdb connect`).
