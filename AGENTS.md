# Luma agent context

## Checks

Use pnpm, Oxlint, and Oxfmt. Node.js 22+ and pnpm 10 are required; `package.json` pins the pnpm version.

```sh
pnpm check
pnpm format:check
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:browser
```

`pnpm check` runs Oxlint and TypeScript. Run `pnpm lint:fix` to apply automatic lint fixes. Oxlint checks TypeScript, React, hooks, and accessibility rules; generated output is excluded. Formatting uses Oxfmt: `pnpm format` writes formatting changes and `pnpm format:check` verifies them.

Build before running browser tests so packaged `file://` tests exercise the current code. Browser checks cover remote navigation, hold-OK options, favorites, settings, search, persistence, focus restoration, weather configuration, temperature units, caching, and TV-service failure behavior with a mock bridge. Weather APIs are mocked; tests do not connect to a TV. On Linux, install Chromium's dependencies with `pnpm exec playwright install --with-deps chromium`.

## Verifying

Smallest proof that the change works. Run only the tests you touched: `node --import tsx --test tests/<file>.test.ts` for a unit contract, `pnpm exec playwright test -g '<spec name>'` for one browser behavior, and targeted lint for changed paths (`pnpm exec oxlint <paths>`). CI owns the full suite on every pull request, so leave the sweeps (`pnpm check`, whole `pnpm test`, whole `pnpm test:browser`) to it unless asked; `pnpm typecheck` is whole-repo by design and cheap enough to run when types move.

Test meaningful logic or observable behavior — the app a bridge launches, the preference a keypress saves, the focused control after a remote move — not internal wiring, static markup, or assertions that mirror the implementation. Never wait on sleeps or polling: assert the state change itself; a test that needs a timeout to pass is wrong.

Behavior changes that cross the platform seam ship with focused unit tests for that platform's contract, and, when user-visible, with browser-test coverage through the mock bridge. When a user-visible change is integrated, run the packaged-file specs once — they exercise the built bundle over `file://`, which is the environment every TV actually receives. Packaged artifacts only get CI coverage for the webOS IPK, so for Tizen and Fire TV the smallest proof is running the packaging script and inspecting the result (`aapt2 dump badging`, `unzip -l`, `apksigner verify`), never eyeballing the build output.

A TV or stick is the developer's real state: `pnpm deploy` to a TV or `adb install` to a stick replaces the installed app and its data, so it happens when the task asks for it, on the target that task names.

## Structure

`src/` contains React/TypeScript UI, spatial navigation, local preferences, and the webOS bridge. `public/` contains locally bundled assets. `tools/` builds a classic-script app and IPK. `tv/autostart.sh` is the optional boot hook.

Project filenames use lowercase kebab-case, including React components (for example, `app-tile.tsx`). Keep `package.json` and `appinfo.json` versions synchronized; change the version only when requested.

## Hit every surface

The most common defect here is a change that works on the one leg you tested and is missing everywhere else. Before calling a change done, walk this list and say which entries applied:

- **Platforms.** The bridge has four implementations of one contract (`webos.ts`, `tizen.ts`, `android.ts`, `desktop.ts`), each paired with its packager (`tools/` for the IPK, `platforms/tizen`, `platforms/firetv`). An inventory, launch, Back, or preferences change needs a decision on every platform — including an explicit "not available here" carried as the bridge's user-facing warning, never silence.
- **Entry points.** Anything a remote key does also has a pointer path (hover, click, right-click), and library actions have both keyboard and menu routes; fixing the keyboard handler alone is not fixing the feature.
- **Assets.** Bundled art (icons, logos, wallpapers, thumbnails) flows through `pnpm assets` and `pnpm build` into every packager; adding or renaming a public asset means regenerating what each platform artifact expects.
- **Docs.** When a change makes guidance in this file inaccurate, rewrite the affected lines rather than appending another account.

## Performance

Keep focus feedback immediate. Spatial navigation caches control geometry and invalidates it on DOM/layout changes, scrolling, resizing, and font loads; fully visible targets do not call `scrollIntoView`. New focusable controls must use `data-focusable` and explicit routes where appropriate.

`data-focus-scroll-top="true"` normalizes the Apps toolbar's scroll position only during remote navigation. Do not scroll the toolbar from a generic focus handler: pointer-down focuses a button before pointer-up, so moving it at that point can swallow the click.

Clock components update at minute boundaries and pause while hidden, independently of the launcher and app sorting. Library filtering/sorting is memoized and only runs on the Apps page. Concurrent inventory refreshes are deduplicated. Use small CSS opacity animations instead of a JavaScript animation runtime, and avoid live backdrop blur or full-screen filter textures in foreground controls. Reduced-motion preferences apply through CSS.

The top navigation uses one persistent selection pill. CSS transitions animate its transform and width; JavaScript measures the selected tab only on selection changes and resize/font-size changes. Initial positioning and resizing are immediate. Both the saved and system reduced-motion preferences disable the pill transition.

Settings uses bundled 480×270 photo thumbnails rather than decoding the full wallpapers for every gallery card. `pnpm assets` regenerates thumbnails. Run `pnpm benchmark` after installing Playwright Chromium to measure a 120-app library with 6× desktop CPU throttling; compare bundle size, keyboard-handler timings, geometry reads, and scroll calls. These measurements are a desktop proxy, not TV frame-rate claims.

Gallery previews use clipped image elements with an inset border, avoiding repeated background-image strips at fractional-sized edges. Neutral interface text, surfaces, icons, and focus rings use gray rather than cream/gold tints. App-action rows have contained focus rings and synchronize pointer hover with keyboard focus; closing the menu restores the selected app, or its nearest surviving neighbor after hiding, after the React commit.

## CI and releases

`.github/workflows/ci.yml` checks pull requests and pushes to `main` on Ubuntu with Node.js 24. It checks formatting, runs unit tests, builds and verifies the IPK, and runs Chromium browser tests. Successful builds upload the release files as a workflow artifact. Successful `main` builds publish new versions using `GITHUB_TOKEN`, automatically creating the version tag at the tested commit. Published versions are skipped; a draft can be resumed when its tag matches that commit. An existing tag pointing elsewhere stops publication. `workflow_dispatch` on `main` provides a manual retry without a tag input. Main runs are serialized so new pushes do not interrupt publication; outdated PR runs can be cancelled.

`tools/repository.mjs` runs after packaging. It creates `dist/repo.json` in Homebrew Channel's paginated package format and copies the native large icon into `dist/`. The feed uses version-specific release URLs and the SHA-256 and size of the normalized IPK. It rejects mismatched package/app versions and release tags, and exposes its validated version tag through `GITHUB_OUTPUT` for the release job. The install URL is `https://github.com/donnes/luma/releases/latest/download/repo.json`; it requires public repository/release access and an initial published release. Publishing the feed as a release asset avoids bot commits to the default branch.

## Remote and pointer controls

| Input                  | Action                                                   |
| ---------------------- | -------------------------------------------------------- |
| Arrow keys             | Spatial navigation between tiles and controls            |
| OK / Enter             | Open the focused app, input, or control                  |
| Hold OK                | Home favorite: move mode; library app: options           |
| Menu / right-click / M | Options for the focused app                              |
| Back / Escape          | Close the current panel; return from Apps/Inputs to Home |
| Back on Home           | webOS's normal platform Back behavior                    |
| Magic Remote pointer   | Point, click, or hold a tile for options                 |

On Home, hold OK on a favorite to enter move mode, press Left/Right to change its position, then press Back to finish. The new order is saved immediately and the selected app stays focused. Apps → select an app → hold OK to add/remove favorites or hide apps. The action menu shows the app name and category, and closes after either action. Favorites have a filled-heart badge and sort first in the saved Home order; other apps sort alphabetically. Hidden apps remain installed and can be restored from the **Hidden (count)** category pill, which shows only hidden apps. Choose a category beside search to filter the library; select it again or use the × button to clear the filter. Long app names wrap instead of being truncated.

Home shows Favorites and Inputs without a recent-app section or permanent control hints. App names beneath Home cards are hidden by default; enable **Settings → Interface → Show app names on Home** to display them. The Apps library always shows names. The header clock is at the top left.

The top navigation includes a full-page **Settings** view, with **Background** on the left and **Interface** above **Weather** on the right. The sliders icon at the top right opens **TV settings** directly. Interface controls Home app names, 12/24-hour time, reduced motion, and refresh. Back returns to Home, and the version number appears at the bottom right of Settings. The moon button in the footer opens the ambient clock on the other pages.

The nine bundled backgrounds are Slate, Midnight, Prism (saturated red, yellow, and purple), Monument Valley, San Francisco, Summit, Forest, Yosemite, and Northern lights. From the Settings tab, Down enters Interface and continues into Weather; Left reaches the background gallery.

Apple TV, Prime Video, Disney+, Jellyfin, Netflix, YouTube, ARTE, ZDF, and Das Erste use bundled SVG logos. Input cards choose connection artwork from the reported device name: PlayStation and Apple TV use their supplied marks, USB uses the USB symbol, unnamed HDMI ports use an HDMI connector, and other devices use a suitable generic icon. Icon selection does not change the input's launch target.

## Weather

Open **Settings → Weather**, enter a city or postcode, press Search, and select the matching place. **Show widget** controls visibility on Home and the ambient screen; turning it off keeps your saved city. Choose **°C** or **°F** under **Temperature** to save your preferred unit for both screens. Switching units converts the cached reading immediately without another weather request. When enabled, the widget shows the chosen city, temperature, and current conditions. Nothing uses browser geolocation or automatic IP-based location lookup.

Back while editing the city/postcode field leaves the field and keeps Settings open. Press Back again from a button to return Home.

Weather refreshes every 15 minutes while Home or the ambient clock is visible. The ambient clock shows weather in place of the return hint when a location is configured. Recent readings are cached locally and reused after reopening the app. If the connection fails, an available cached reading is labeled as saved; otherwise the widget says weather is unavailable. Remove the weather location in Settings to turn it off. API and cached temperatures stay in Celsius; `formatTemperature` converts the unrounded value for display.

Location search calls `geocoding-api.open-meteo.com`, and weather calls `api.open-meteo.com`. Those are the only network origins allowed by the packaged app's Content Security Policy. No API key or account is required. Data attribution: [Open-Meteo](https://open-meteo.com/) / [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
