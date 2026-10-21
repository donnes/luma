# Luma assets and references

- `public/mark.svg`, `public/app-icon.svg`, `public/wallpapers/midnight.svg`, `public/wallpapers/slate.svg`, and `public/wallpapers/prism.svg`: original Luma artwork, MIT. The TV app icon has a transparent background; webOS supplies the panel via `iconColor`, so there is no second background with its own clipping radius.
- `public/wallpapers/dunes.jpg`: Unsplash photo `1509316785289-025f5b846b35`, https://images.unsplash.com/photo-1509316785289-025f5b846b35. Bundled under the [Unsplash License](https://unsplash.com/license).
- `public/wallpapers/san-francisco.jpg`: Unsplash photo `1501594907352-04cda38ebc29`, https://images.unsplash.com/photo-1501594907352-04cda38ebc29. Bundled under the [Unsplash License](https://unsplash.com/license).
- `public/wallpapers/summit.jpg`: Unsplash photo `1454496522488-7a8e488e8606`, https://images.unsplash.com/photo-1454496522488-7a8e488e8606. Bundled under the [Unsplash License](https://unsplash.com/license).
- `public/wallpapers/forest.jpg`: Unsplash photo `1441974231531-c6227db76b6e`, https://images.unsplash.com/photo-1441974231531-c6227db76b6e. Bundled under the [Unsplash License](https://unsplash.com/license).
- `public/wallpapers/yosemite.jpg`: [Tunnel View, Yosemite Valley, Yosemite NP](https://commons.wikimedia.org/wiki/File:Tunnel_View,_Yosemite_Valley,_Yosemite_NP_-_Diliff.jpg) by David Iliff (Diliff), [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). Resized to a 2560px-wide JPEG; the image retains its CC BY-SA 3.0 license.
- `public/wallpapers/northern-lights.jpg`: Unsplash photo `1531366936337-7c912a4589a7`, https://images.unsplash.com/photo-1531366936337-7c912a4589a7. Bundled under the [Unsplash License](https://unsplash.com/license).
- Inter variable font: Rasmus Andersson, SIL Open Font License 1.1. License bundled at `public/fonts/ofl.txt`.
- Interface icons: Lucide, ISC license (dependency license in node_modules/lucide-react/LICENSE).
- Brand treatments identify installed third-party apps; their names and marks belong to their respective owners. Luma is not affiliated with those companies, Apple, or LG.

Luma's logo is a folded-light **L**: an icy-blue ribbon turns into a cyan-and-indigo base. The browser mark and TV app icon share the same vector geometry, sized for a clear silhouette at small icon sizes.

`public/wallpaper-thumbnails/` contains 480×270 JPEG derivatives of the photographs listed above. They are resized/cropped for the Settings gallery and retain each source photograph's license and attribution.

## Brand SVGs

The requested app logos use downloaded vector artwork, rather than font approximations. SVG outlines are preserved; Apple TV, Disney+, Prime Video, and Das Erste use a white monochrome display treatment for contrast. YouTube's wordmark is recolored white for its dark card, while its play icon stays red. All files are bundled locally under `public/logos/`. On Fire TV, apps without a bundled logo use the TV banner or icon the app itself ships, drawn by the shell at runtime; nothing is bundled for them.

| Asset             | Source                                                                                                                          | Source license / attribution                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `apple-tv.svg`    | [Apple TV logo](https://commons.wikimedia.org/wiki/File:Apple_TV_logo.svg)                                                      | Apple Inc.; public-domain logo artwork                                                                                              |
| `prime-video.svg` | [Amazon Prime Video logo](https://commons.wikimedia.org/wiki/File:Amazon_Prime_Video_logo.svg)                                  | Amazon; public-domain logo artwork                                                                                                  |
| `disney-plus.svg` | [Disney+ logo](https://commons.wikimedia.org/wiki/File:Disney%2B_logo.svg)                                                      | Disney Enterprises, Inc.; public-domain logo artwork                                                                                |
| `jellyfin.svg`    | [Jellyfin official branding, banner-dark.svg](https://github.com/jellyfin/jellyfin-ux/blob/master/branding/SVG/banner-dark.svg) | Jellyfin contributors; [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/); original license notice retained in the SVG |
| `netflix.svg`     | [Netflix 2015 logo](https://commons.wikimedia.org/wiki/File:Netflix_2015_logo.svg)                                              | Netflix Inc.; public-domain logo artwork                                                                                            |
| `youtube.svg`     | [YouTube 2024](https://commons.wikimedia.org/wiki/File:YouTube_2024.svg)                                                        | Google Inc.; public-domain logo artwork                                                                                             |
| `arte.svg`        | [ARTE 2026 logo](https://commons.wikimedia.org/wiki/File:Arte_Logo_2026.svg)                                                    | ARTE; public-domain logo artwork                                                                                                    |
| `zdf.svg`         | [ZDF logo](https://commons.wikimedia.org/wiki/File:ZDF_logo.svg)                                                                | ZDF; public-domain logo artwork                                                                                                     |
| `das-erste.svg`   | [Das Erste 2014](https://commons.wikimedia.org/wiki/File:Das_Erste_2014.svg)                                                    | ARD; public-domain logo artwork                                                                                                     |
| `spotify.svg`     | [svgl.app: Spotify wordmark](https://svgl.app/library/spotify_wordmark.svg)                                                     | Spotify AB; trademark of its owner, distributed by svgl                                                                             |
| `twitch.svg`      | [svgl.app: Twitch](https://svgl.app/library/twitch.svg)                                                                         | Twitch Interactive, Inc.; trademark of its owner, distributed by svgl                                                               |

The T3 Code mark on the Agents tile is the path from T3 Code's `assets/prod/logo.svg` ([pingdotgg/t3code](https://github.com/pingdotgg/t3code), MIT). It identifies the T3 Code server Luma pairs with; Luma is not affiliated with T3 Tools.

The PlayStation and Apple TV input symbols use the SVG paths supplied by the user. PlayStation is a Sony Interactive Entertainment mark; Apple TV is an Apple mark. HDMI, USB, and generic device symbols are Lucide icons.

The Apple design guidance supplied for this project informed motion, focus feedback, materials, typography, and reduced-motion behavior. It is not an Apple product.
