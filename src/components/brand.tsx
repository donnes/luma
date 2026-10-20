import { AppWindow, Coffee, Gamepad2, Globe, MonitorPlay, Settings2, Tv } from 'lucide-react';
import type { TVApp } from '../types';
import appIcons from '../app-icons.json';
import { useTranslation } from '../i18n';

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
  const installedIcon = (appIcons as Record<string, string>)[app.id];
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
    case 'spotify':
      return (
        <span className="wordmark wordmark-spotify">
          <svg viewBox="0 0 48 48" aria-hidden="true">
            <circle cx="24" cy="24" r="24" fill="currentColor" />
            <g fill="none" stroke="#15271c" strokeLinecap="round">
              <path d="M11 18q15-6 27 2" strokeWidth="4" />
              <path d="M13 25q13-5 23 2" strokeWidth="3.5" />
              <path d="M15 32q10-4 18 1" strokeWidth="3" />
            </g>
          </svg>
          Spotify
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
