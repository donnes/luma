import type { Preferences } from './types';
import { parseLocation } from './weather';
import { wallpapers } from './wallpapers';

export const STORAGE_KEY = 'luma.preferences.v1';
export const defaults: Preferences = {
  version: 1,
  favorites: null,
  hidden: [],
  recent: [],
  wallpaper: 'dunes',
  reducedMotion: false,
  clock24: false,
  showHomeAppNames: false,
  showWeather: true,
  temperatureUnit: 'celsius',
  language: 'en',
  weatherLocation: null,
};

const ids = (value: unknown): string[] =>
  Array.isArray(value)
    ? [
        ...new Set(
          value.filter(
            (id): id is string => typeof id === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(id),
          ),
        ),
      ].slice(0, 1000)
    : [];

export function parsePreferences(raw: string | null): Preferences {
  try {
    const value = JSON.parse(raw ?? 'null');
    if (!value || value.version !== 1) return { ...defaults };
    return {
      version: 1,
      favorites: !Array.isArray(value.favorites) ? null : ids(value.favorites),
      hidden: ids(value.hidden),
      recent: ids(value.recent).slice(0, 12),
      wallpaper: wallpapers.some((wallpaper) => wallpaper.id === value.wallpaper)
        ? value.wallpaper
        : 'dunes',
      reducedMotion: value.reducedMotion === true,
      clock24: value.clock24 === true,
      showHomeAppNames: value.showHomeAppNames === true,
      showWeather: value.showWeather !== false,
      temperatureUnit: value.temperatureUnit === 'fahrenheit' ? 'fahrenheit' : 'celsius',
      language: value.language === 'de' || value.language === 'zh' ? value.language : 'en',
      weatherLocation: parseLocation(value.weatherLocation),
    };
  } catch {
    return { ...defaults };
  }
}

export function loadPreferences(): Preferences {
  try {
    return parsePreferences(localStorage.getItem(STORAGE_KEY));
  } catch {
    return { ...defaults };
  }
}

export function savePreferences(value: Preferences): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
