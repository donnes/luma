# Luma

A modern, remote-first launcher for rooted LG webOS TVs, inspired by the clarity and feel of Apple TV.

> [!NOTE]
> Tested on **LG OLED55C57** running **webOS 26**.

![Luma home screen, desktop preview](docs/home.png)

## Install

Use [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel) on your rooted LG TV.

1. Open Homebrew Channel and check **Settings → Root status: ok**.
2. Go to **Settings → Add repository**, enter this URL, and confirm:

   ```text
   https://github.com/donnes/luma/releases/latest/download/repo.json
   ```

3. Return to the app list, select **Luma**, and choose **Install**.
4. Open **Luma** from your TV's apps.

### Manual installation

Download the `.ipk` from the [latest release](https://github.com/donnes/luma/releases/latest). Open [webOS Dev Manager](https://github.com/webosbrew/dev-manager-desktop), connect to your TV's IP address on port `22` as `root`, and install the downloaded package.

You can also install over SSH. Replace `TV_IP` with your TV's address and use the filename you downloaded:

```sh
scp -O com.luma.launcher_1.0.1_all.ipk root@TV_IP:/tmp/luma.ipk
ssh root@TV_IP
```

Then run in the TV's root shell:

```sh
luna-send -i luna://com.webos.appInstallService/dev/install \
  '{"id":"com.luma.launcher","ipkUrl":"/tmp/luma.ipk","subscribe":true}'
```

Wait for the installation success response, then press Ctrl+C if the subscription stays open. Fully close and reopen Luma after updating.

## Optional: open at boot

After testing the installed app, run this inside the TV's root SSH shell:

```sh
sh /media/developer/apps/usr/palm/applications/com.luma.launcher/autostart.sh enable
```

This adds an app-owned hook at `/var/lib/webosbrew/init.d/65-luma`. It launches after a full boot with a 25-second delay. It does not run on every standby wake. Disable it before uninstalling:

```sh
sh /media/developer/apps/usr/palm/applications/com.luma.launcher/autostart.sh disable
```

## Optional: remote Home button

Use [LG Input Hook](https://repo.webosbrew.org/apps/org.webosbrew.inputhook/) to map your remote's Home key to this command (one line):

```sh
/usr/bin/luna-send -t 1 -w 5000 luna://com.webos.service.applicationmanager/launch '{"id":"com.luma.launcher"}'
```

Test the mapping on a spare button first. Disable any other Home-button listener before enabling Luma's mapping. Disable the Luma mapping in Input Hook to restore the normal button.

Luma does not inject code into LG services, replace the stock launcher, or bind-mount system directories. Root-only Home routing is separate from the app itself.

## Troubleshooting

### webOS 26: denied exec method

Homebrew Channel 0.8.0-rc1 or newer provides the `lunabus.query` API permission mapping for elevated services ([upstream fix](https://github.com/webosbrew/webos-homebrew-channel/pull/233)). Luma declares that group alongside its app-launch permissions. Update Homebrew Channel and reinstall the latest Luma release if an older installation reports `Denied method call "exec" for category "/"`.

If the denial persists after reopening Luma, perform a full TV reboot. If it still occurs, inspect the installed caller permissions and the Homebrew service mapping from the root SSH shell:

```sh
cat /var/luna-service2*/client-permissions.d/com.luma.launcher*.json
cat /var/luna-service2*/api-permissions.d/org.webosbrew.hbchannel.service.api.lunabus.query.json
```

The caller needs `lunabus.query`, and Homebrew's mapping should contain `{"lunabus.query":["org.webosbrew.hbchannel.service/*"]}`. Homebrew Channel must also be elevated. Installing Luma via `luna-send` does not require elevating Luma itself.

## Compatibility and privacy

- Targets webOS 24–26 / Chromium 108+. Graphics are packaged at 1920 × 1080 and scale for desktop preview.
- App/input discovery uses Homebrew Channel's elevated `exec` service. Fixed inventory commands read only app and physical-input lists.
- App launches use the public application manager API with the `application.launcher` and `application.query` ACGs. Homebrew service access declares `lunabus.query` for webOS 26 / Homebrew Channel 0.8.0-rc1. No service permissions are rewritten.
- Service bridges are retained until completion, bounded by timeouts, and cancelled afterward. Partial refresh failures preserve the last valid inventory.
- All app names and IDs come from inventory on the TV. A failure never substitutes desktop sample apps.
- Preferences, recent launches, weather location, and cached readings stay in this app's local storage. Forecast requests require an enabled widget and a configured location; city searches are sent only when you press Search. The packaged Content Security Policy limits web network connections to Open-Meteo's weather and geocoding APIs.
- Homebrew Channel permissions and native service behavior need verification on the physical TV, particularly webOS 26. Browser tests cannot establish hardware compatibility.

## Development

Use Node.js 22+ and pnpm 10 (the project pins pnpm 10.34.5):

```sh
git clone https://github.com/donnes/luma.git
cd luma
pnpm install --frozen-lockfile
pnpm dev
```

Open **http://127.0.0.1:5173**. The browser preview uses sample apps and inputs; TV actions show a preview message. On a TV, Luma loads the actual inventory.

### Build a package

```sh
pnpm run package
```

Output: `dist/com.luma.launcher_1.0.1_all.ipk`, `dist/sha256sums`, and the Homebrew feed `dist/repo.json` with its icon. The standalone app is in `dist/app/` and works directly from `index.html` without a server.

Photographs, fonts, and app-logo SVGs are bundled locally. `pnpm assets` prepares them again if deliberately removed; normal builds and TV use need no asset downloads.

To deploy a local build, register your TV's root SSH connection with `pnpm exec ares-setup-device`, then run `pnpm run deploy --device tv`.

### Releases

GitHub Actions checks pull requests and pushes to `main`, runs the unit and browser tests, and builds the installable package. After a successful build on `main`, CI publishes a new app version with its IPK, checksum, icon, and Homebrew feed. The version tag (for example, `v1.0.1`) is created automatically at the tested commit.

For each release, update the version in both `package.json` and `appinfo.json`, then merge to `main`. Already-published versions are skipped. To retry a failed run, use **Actions → CI → Run workflow** on `main`.

The stable feed URL always serves the latest release. Contributor checks, controls, weather behavior, and the code map are documented in [agents.md](agents.md).

## Credits

A fork of [Luma for LG webOS](https://github.com/ecklf/lg-luma) by ecklf, extended to run on multiple TV platforms.

## License

MIT for Luma's source. See [assets.md](assets.md) for artwork, font, icon, and integration references.
