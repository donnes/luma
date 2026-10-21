import { AppWindow, Coffee, Gamepad2, Globe, MonitorPlay, Settings2, Tv } from 'lucide-react';
import type { TVApp } from '../types';
import appIcons from '../app-icons.json';
import { useTranslation } from '../i18n';
import { AgentsMark } from './agents/agents-mark';

const logos: Record<string, string> = {
  apple: 'apple-tv',
  prime: 'prime-video',
  disney: 'disney-plus',
  jellyfin: 'jellyfin',
  netflix: 'netflix',
  youtube: 'youtube',
  arte: 'arte',
  zdf: 'zdf',
  'das-erste': 'das-erste',
  spotify: 'spotify',
  twitch: 'twitch',
};

export function Brand({ app }: { app: TVApp }) {
  const { t } = useTranslation();
  const logo = logos[app.brand];
  if (logo)
    return (
      <img
        className={`brand-logo brand-logo-${app.brand}`}
        src={`./logos/${logo}.svg`}
        alt=""
        draggable={false}
      />
    );
  // Installed artwork: icons collected from the webOS TV, or the banner/icon
  // the Fire TV shell draws for any installed app.
  const art = app.art ? `./app-art/${encodeURIComponent(app.id)}.png` : undefined;
  if (app.art === 'banner')
    return (
      <span className="brand-installed brand-banner">
        <img
          src={art}
          alt=""
          draggable={false}
          decoding="async"
          onError={(event) => {
            event.currentTarget.style.display = 'none';
            const label = event.currentTarget.nextElementSibling as HTMLElement | null;
            if (label) label.hidden = false;
          }}
        />
        <span hidden>{app.title}</span>
      </span>
    );
  const installedIcon = (appIcons as Record<string, string>)[app.id] ?? art;
  if (installedIcon)
    return (
      <span className="brand-installed">
        <img
          className="brand-installed-icon"
          src={installedIcon}
          alt=""
          draggable={false}
          onError={(event) => {
            event.currentTarget.style.display = 'none';
            const label = event.currentTarget.nextElementSibling as HTMLElement | null;
            if (label) label.hidden = false;
          }}
        />
        <span hidden>{app.title}</span>
      </span>
    );
  switch (app.brand) {
    case 'agents':
      return <AgentsMark />;
    case 'live-tv':
      return (
        <span className="brand-symbol">
          <Tv />
          <span>{t('liveTV')}</span>
        </span>
      );
    case 'plex':
      return (
        <span className="wordmark wordmark-plex">
          ple<span className="plex-x">x</span>
        </span>
      );
    case 'homebrew':
      return (
        <span className="brand-symbol">
          <Coffee />
          <span>{t('homebrew')}</span>
        </span>
      );
    case 'kodi':
      return (
        <span className="wordmark wordmark-kodi">
          <span className="kodi-symbol">❖</span>kodi
        </span>
      );
    case 'moonlight':
      return (
        <span className="brand-symbol">
          <MonitorPlay />
          <span>Moonlight</span>
        </span>
      );
    case 'browser':
      return (
        <span className="brand-symbol">
          <Globe />
          <span>{t('browser')}</span>
        </span>
      );
    case 'gaming':
      return (
        <span className="brand-symbol">
          <Gamepad2 />
          <span>{app.title}</span>
        </span>
      );
    case 'settings':
      return (
        <span className="brand-symbol">
          <Settings2 />
          <span>{t('settings')}</span>
        </span>
      );
    default:
      return (
        <span className="brand-symbol brand-generic">
          <AppWindow />
          <span>{app.title}</span>
        </span>
      );
  }
}
