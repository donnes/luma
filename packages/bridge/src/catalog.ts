import type { TVApp, TVInput, Category } from './types';

const identities: { match: RegExp; brand: string; category: Category }[] = [
  { match: /(?:com\.webos\.app\.livetv|live[\s._-]*tv)/i, brand: 'live-tv', category: 'Streaming' },
  { match: /netflix/i, brand: 'netflix', category: 'Streaming' },
  { match: /youtube/i, brand: 'youtube', category: 'Streaming' },
  { match: /disney/i, brand: 'disney', category: 'Streaming' },
  { match: /apple.?tv|appletv/i, brand: 'apple', category: 'Streaming' },
  { match: /amazon|prime.?video/i, brand: 'prime', category: 'Streaming' },
  { match: /jellyfin/i, brand: 'jellyfin', category: 'Streaming' },
  { match: /(?:^|[.\s_-])arte(?:$|[.\s_-])/i, brand: 'arte', category: 'Streaming' },
  { match: /zdf/i, brand: 'zdf', category: 'Streaming' },
  {
    match: /das[\s._-]*erste|(?:^|[.\s_-])ard(?:$|[.\s_-])|ardmediathek/i,
    brand: 'das-erste',
    category: 'Streaming',
  },
  { match: /plex/i, brand: 'plex', category: 'Streaming' },
  { match: /kodi/i, brand: 'kodi', category: 'Streaming' },
  { match: /spotify/i, brand: 'spotify', category: 'Music' },
  { match: /moonlight|limelight/i, brand: 'moonlight', category: 'Gaming' },
  { match: /retroarch|game|steam/i, brand: 'gaming', category: 'Gaming' },
  { match: /hbchannel|homebrew/i, brand: 'homebrew', category: 'Utilities' },
  { match: /browser/i, brand: 'browser', category: 'Utilities' },
  { match: /settings/i, brand: 'settings', category: 'Utilities' },
];

export function appIdentity(id: string, title: string): TVApp {
  const match = identities.find((identity) => identity.match.test(`${id} ${title}`));
  return { id, title, brand: match?.brand ?? 'generic', category: match?.category ?? 'Utilities' };
}

export function validAppId(id: unknown): id is string {
  return (
    typeof id === 'string' && id.length <= 128 && /^[a-zA-Z0-9]+(?:[._-][a-zA-Z0-9]+)*$/.test(id)
  );
}

export function normalizeApps(raw: unknown): TVApp[] {
  if (!Array.isArray(raw) || raw.length > 1000)
    throw new Error('The TV returned an invalid app list.');
  const seen = new Set<string>();
  return raw
    .flatMap((entry) => {
      if (
        !entry ||
        !validAppId(entry.id) ||
        seen.has(entry.id) ||
        entry.visible === false ||
        entry.visible === 'false'
      )
        return [];
      // Internal services, input stubs and Luma itself aren't applications to put in the library.
      if (
        entry.id === 'com.luma.launcher' ||
        entry.id === 'com.webos.app.home' ||
        entry.id.startsWith('com.webos.app.hdmi') ||
        entry.id.startsWith('com.webos.app.externalinput.')
      )
        return [];
      if (
        entry.visible !== true &&
        entry.id !== 'com.webos.app.livetv' &&
        /^(com\.webos\.|com\.palm\.|com\.lge\.)/.test(entry.id)
      )
        return [];
      seen.add(entry.id);
      const title =
        typeof entry.title === 'string'
          ? entry.title
              // oxlint-disable-next-line eslint/no-control-regex -- Remove control characters from TV-supplied labels.
              .replace(/[\u0000-\u001f\u007f]/g, '')
              .trim()
              .slice(0, 120)
          : entry.id;
      return [appIdentity(entry.id, title || entry.id)];
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

export function normalizeInputs(raw: unknown): TVInput[] {
  if (!Array.isArray(raw) || raw.length > 128)
    throw new Error('The TV returned an invalid input list.');
  const counts = new Map<string, number>();
  for (const entry of raw)
    if (entry?.appId) counts.set(entry.appId, (counts.get(entry.appId) ?? 0) + 1);
  return raw.flatMap((entry) => {
    const match = /^com\.webos\.app\.hdmi([1-9][0-9]?)$/.exec(entry?.appId ?? '');
    if (!match || counts.get(entry.appId) !== 1) return [];
    if (entry.id !== undefined && entry.id !== `HDMI_${match[1]}`) return [];
    if (entry.port !== undefined && String(entry.port) !== match[1]) return [];
    const port = `HDMI ${match[1]}`;
    const title =
      typeof entry.label === 'string' && entry.label.trim()
        ? entry.label
            // oxlint-disable-next-line eslint/no-control-regex -- Remove control characters from TV-supplied labels.
            .replace(/[\u0000-\u001f\u007f]/g, '')
            .trim()
            .slice(0, 120)
        : port;
    const kind = /playstation|xbox|switch|console/i.test(title)
      ? 'console'
      : /apple|stream|fire|roku/i.test(title)
        ? 'streamer'
        : /pc|computer|laptop/i.test(title)
          ? 'computer'
          : 'hdmi';
    return [
      {
        id: entry.appId,
        title,
        port,
        kind,
        connected: typeof entry.connected === 'boolean' ? entry.connected : null,
      } as TVInput,
    ];
  });
}

export function sortApps(apps: TVApp[], favorites: readonly string[]): TVApp[] {
  const ranks = new Map(favorites.map((id, index) => [id, index]));
  return [...apps].sort((a, b) => {
    const first = ranks.get(a.id);
    const second = ranks.get(b.id);
    if (first !== undefined && second !== undefined) return first - second;
    if (first !== undefined) return -1;
    if (second !== undefined) return 1;
    return a.title.localeCompare(b.title);
  });
}

export function defaultFavorites(apps: TVApp[]): string[] {
  const brands = ['netflix', 'youtube', 'apple', 'disney', 'prime', 'plex'];
  const preferred = brands.flatMap((brand) => apps.find((app) => app.brand === brand)?.id ?? []);
  return [...new Set([...preferred, ...apps.map((app) => app.id)])].slice(0, 6);
}

// Fixtures exist only in the desktop preview. A TV never falls back to these.
export const demoApps = [
  ['com.webos.app.livetv', 'Live TV'],
  ['netflix', 'Netflix'],
  ['youtube.leanback.v4', 'YouTube'],
  ['com.apple.appletv', 'Apple TV'],
  ['com.disney.disneyplus-prod', 'Disney+'],
  ['amazon', 'Prime Video'],
  ['plex', 'Plex'],
  ['spotify-beehive', 'Spotify'],
  ['org.jellyfin.webos', 'Jellyfin'],
  ['org.xbmc.kodi', 'Kodi'],
  ['com.limelight.webos', 'Moonlight'],
  ['org.webosbrew.hbchannel', 'Homebrew Channel'],
  ['com.webos.app.browser', 'Web Browser'],
  ['com.arte.tv', 'ARTE'],
  ['zdf', 'ZDF'],
  ['ard', 'Das Erste'],
].map(([id, title]) => appIdentity(id, title));

export const demoInputs: TVInput[] = [
  {
    id: 'com.webos.app.hdmi1',
    title: 'PlayStation 5',
    port: 'HDMI 1',
    connected: true,
    kind: 'console',
  },
  {
    id: 'com.webos.app.hdmi2',
    title: 'Apple TV',
    port: 'HDMI 2',
    connected: true,
    kind: 'streamer',
  },
  { id: 'com.webos.app.hdmi3', title: 'HDMI 3', port: 'HDMI 3', connected: false, kind: 'hdmi' },
];
