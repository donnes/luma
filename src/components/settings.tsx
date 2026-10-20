import {
  Accessibility,
  Check,
  ChevronRight,
  Clock3,
  Languages,
  RefreshCw,
  Type,
} from 'lucide-react';
import { WeatherSettings } from './weather-settings';
import type { Language, Preferences } from '../types';
import { wallpapers, wallpaperThumbnail } from '../wallpapers';
import { useTranslation, wallpaperLabel } from '../i18n';

interface Props {
  preferences: Preferences;
  onUpdate: (patch: Partial<Preferences>) => void;
  onRefresh: () => void;
}

export function Settings({ preferences, onUpdate, onRefresh }: Props) {
  const { t, language } = useTranslation();
  return (
    <section className="settings-page" aria-label={t('settings')}>
      <h1 className="sr-only">{t('settings')}</h1>
      <div className="settings-layout">
        <section
          className="settings-panel settings-backgrounds"
          aria-labelledby="background-heading"
        >
          <h2 className="settings-section-title" id="background-heading">
            {t('background')}
          </h2>
          <div className="wallpaper-options">
            {wallpapers.map((wallpaper) => (
              <button
                key={wallpaper.id}
                className={`wallpaper-option${preferences.wallpaper === wallpaper.id ? ' selected' : ''}`}
                data-focusable={`wallpaper-${wallpaper.id}`}
                aria-pressed={preferences.wallpaper === wallpaper.id}
                onClick={() => onUpdate({ wallpaper: wallpaper.id })}
              >
                <span className="wallpaper-thumbnail">
                  <img
                    src={wallpaperThumbnail(wallpaper.image)}
                    alt=""
                    draggable={false}
                    decoding="async"
                  />
                  {preferences.wallpaper === wallpaper.id ? (
                    <span className="wallpaper-check">
                      <Check size={18} />
                    </span>
                  ) : null}
                </span>
                <span>{wallpaperLabel(language, wallpaper.id, wallpaper.title)}</span>
              </button>
            ))}
          </div>
        </section>
        <div className="settings-controls">
          <section className="settings-panel" aria-labelledby="interface-heading">
            <h2 className="settings-section-title" id="interface-heading">
              {t('interface')}
            </h2>
            <div className="settings-group">
              <button
                className="setting-row"
                role="switch"
                aria-checked={preferences.showHomeAppNames}
                data-focusable="setting-home-app-names"
                data-focus-up="nav-settings"
                onClick={() => onUpdate({ showHomeAppNames: !preferences.showHomeAppNames })}
              >
                <Type />
                <span>
                  <strong>{t('showAppNames')}</strong>
                </span>
                <span className={`toggle${preferences.showHomeAppNames ? ' on' : ''}`}>
                  <i />
                </span>
              </button>
              <button
                className="setting-row"
                role="switch"
                aria-checked={preferences.clock24}
                data-focusable="setting-clock"
                onClick={() => onUpdate({ clock24: !preferences.clock24 })}
              >
                <Clock3 />
                <span>
                  <strong>{t('clock24')}</strong>
                </span>
                <span className={`toggle${preferences.clock24 ? ' on' : ''}`}>
                  <i />
                </span>
              </button>
              <button
                className="setting-row"
                role="switch"
                aria-checked={preferences.reducedMotion}
                data-focusable="setting-motion"
                onClick={() => onUpdate({ reducedMotion: !preferences.reducedMotion })}
              >
                <Accessibility />
                <span>
                  <strong>{t('reducedMotion')}</strong>
                </span>
                <span className={`toggle${preferences.reducedMotion ? ' on' : ''}`}>
                  <i />
                </span>
              </button>
              <label className="setting-row language-option" htmlFor="display-language">
                <Languages aria-hidden="true" />
                <span>
                  <strong>{t('language')}</strong>
                </span>
                <select
                  id="display-language"
                  className="language-select"
                  data-focusable="setting-language"
                  aria-label={t('languageMenu')}
                  value={preferences.language}
                  onKeyDown={(event) => {
                    if (event.key.startsWith('Arrow')) event.stopPropagation();
                  }}
                  onChange={(event) => onUpdate({ language: event.target.value as Language })}
                >
                  <option value="en">{t('english')}</option>
                  <option value="de">{t('german')}</option>
                  <option value="zh">{t('chinese')}</option>
                </select>
              </label>
            </div>
            <div className="settings-group">
              <button className="setting-row" data-focusable="setting-refresh" onClick={onRefresh}>
                <RefreshCw />
                <span>
                  <strong>{t('refreshApps')}</strong>
                </span>
                <ChevronRight />
              </button>
            </div>
          </section>
          <section className="settings-panel">
            <WeatherSettings
              location={preferences.weatherLocation}
              onChange={(weatherLocation) => onUpdate({ weatherLocation })}
              enabled={preferences.showWeather}
              onEnabledChange={(showWeather) => onUpdate({ showWeather })}
              unit={preferences.temperatureUnit}
              onUnitChange={(temperatureUnit) => onUpdate({ temperatureUnit })}
            />
          </section>
        </div>
      </div>
    </section>
  );
}
