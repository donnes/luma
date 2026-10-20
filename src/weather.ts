import type { Language, TemperatureUnit, WeatherLocation, WeatherReading } from './types';

export const WEATHER_CACHE_KEY = 'luma.weather.v1';
export const WEATHER_REFRESH_MS = 15 * 60 * 1000;
const MAX_CACHE_AGE_MS = 6 * 60 * 60 * 1000;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const text = (value: unknown) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 120) : '';

export function parseLocation(value: unknown): WeatherLocation | null {
  if (
    !record(value) ||
    !text(value.name) ||
    typeof value.latitude !== 'number' ||
    typeof value.longitude !== 'number' ||
    !Number.isFinite(value.latitude) ||
    !Number.isFinite(value.longitude) ||
    Math.abs(value.latitude) > 90 ||
    Math.abs(value.longitude) > 180
  )
    return null;
  return {
    name: text(value.name),
    region: text(value.region),
    country: text(value.country),
    latitude: value.latitude,
    longitude: value.longitude,
  };
}

export const locationKey = (location: WeatherLocation) =>
  `${location.latitude.toFixed(4)},${location.longitude.toFixed(4)}`;
export const locationDetail = (location: WeatherLocation) =>
  [
    ...new Set(
      [location.region, location.country].filter((part) => part && part !== location.name),
    ),
  ].join(', ');

export function formatTemperature(celsius: number, unit: TemperatureUnit): string {
  const temperature = unit === 'fahrenheit' ? (celsius * 9) / 5 + 32 : celsius;
  return `${Math.round(temperature)}°${unit === 'fahrenheit' ? 'F' : 'C'}`;
}

async function requestJSON(url: URL, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 8000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw new Error('Open-Meteo is unavailable. Try again shortly.');
    return await response.json();
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function searchLocations(
  query: string,
  signal?: AbortSignal,
  language: Language = 'en',
): Promise<WeatherLocation[]> {
  const name = query.trim().slice(0, 120);
  if (name.length < 2) throw new Error('Enter at least two characters.');
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  const apiLanguage = language === 'zh' ? 'zh' : language;
  url.search = new URLSearchParams({
    name,
    count: '6',
    language: apiLanguage,
    format: 'json',
  }).toString();
  const value = await requestJSON(url, signal);
  if (
    !record(value) ||
    value.error === true ||
    (value.results !== undefined && !Array.isArray(value.results))
  )
    throw new Error('The location service returned an unreadable response.');
  const seen = new Set<string>();
  return ((value.results as unknown[] | undefined) ?? []).slice(0, 20).flatMap((entry) => {
    if (!record(entry)) return [];
    const location = parseLocation({ ...entry, region: entry.admin1 });
    if (!location || seen.has(locationKey(location))) return [];
    seen.add(locationKey(location));
    return [location];
  });
}

export function parseWeather(value: unknown): WeatherReading {
  const current = record(value) && record(value.current) ? value.current : null;
  if (
    !current ||
    typeof current.temperature_2m !== 'number' ||
    !Number.isFinite(current.temperature_2m) ||
    current.temperature_2m < -100 ||
    current.temperature_2m > 70 ||
    typeof current.weather_code !== 'number' ||
    !Number.isInteger(current.weather_code) ||
    current.weather_code < 0 ||
    current.weather_code > 99 ||
    (current.is_day !== 0 && current.is_day !== 1)
  )
    throw new Error('The weather service returned an unreadable reading.');
  return {
    temperature: current.temperature_2m,
    code: current.weather_code,
    isDay: current.is_day === 1,
  };
}

export async function fetchWeather(
  location: WeatherLocation,
  signal?: AbortSignal,
): Promise<WeatherReading> {
  if (!parseLocation(location)) throw new Error('Choose a valid weather location.');
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    current: 'temperature_2m,is_day,weather_code',
    temperature_unit: 'celsius',
    timezone: 'auto',
  }).toString();
  return parseWeather(await requestJSON(url, signal));
}

export interface CachedWeather {
  key: string;
  updatedAt: number;
  reading: WeatherReading;
}

export function readWeatherCache(location: WeatherLocation): CachedWeather | null {
  try {
    const cache = JSON.parse(localStorage.getItem(WEATHER_CACHE_KEY) ?? 'null');
    if (
      !record(cache) ||
      cache.key !== locationKey(location) ||
      typeof cache.updatedAt !== 'number' ||
      !Number.isFinite(cache.updatedAt) ||
      !record(cache.reading)
    )
      return null;
    const age = Date.now() - cache.updatedAt;
    if (age < 0 || age > MAX_CACHE_AGE_MS) return null;
    const reading = parseWeather({
      current: {
        temperature_2m: cache.reading.temperature,
        weather_code: cache.reading.code,
        is_day: cache.reading.isDay === true ? 1 : cache.reading.isDay === false ? 0 : null,
      },
    });
    return { key: cache.key as string, updatedAt: cache.updatedAt, reading };
  } catch {
    return null;
  }
}

export function saveWeatherCache(cache: CachedWeather): void {
  try {
    localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* Weather remains usable when storage is full. */
  }
}

export function clearWeatherCache(): void {
  try {
    localStorage.removeItem(WEATHER_CACHE_KEY);
  } catch {
    /* Storage is optional. */
  }
}

export function weatherCondition(
  code: number,
  isDay: boolean,
  language: Language = 'en',
): {
  label: string;
  icon: 'sun' | 'moon' | 'partly-cloudy' | 'cloud' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'storm';
} {
  const labels = {
    en: [
      'Clear skies',
      'Clear night',
      'Mostly clear',
      'Partly cloudy',
      'Overcast',
      'Fog',
      'Drizzle',
      'Rain',
      'Snow',
      'Thunderstorms',
      'Current weather',
    ],
    de: [
      'Klarer Himmel',
      'Klare Nacht',
      'Überwiegend klar',
      'Teilweise bewölkt',
      'Bedeckt',
      'Nebel',
      'Nieselregen',
      'Regen',
      'Schnee',
      'Gewitter',
      'Aktuelles Wetter',
    ],
    zh: [
      '晴朗',
      '晴朗的夜晚',
      '大致晴朗',
      '局部多云',
      '阴天',
      '雾',
      '毛毛雨',
      '雨',
      '雪',
      '雷暴',
      '当前天气',
    ],
  }[language];
  if (code === 0) return { label: labels[isDay ? 0 : 1], icon: isDay ? 'sun' : 'moon' };
  if (code === 1 || code === 2) return { label: labels[code === 1 ? 2 : 3], icon: 'partly-cloudy' };
  if (code === 3) return { label: labels[4], icon: 'cloud' };
  if (code === 45 || code === 48) return { label: labels[5], icon: 'fog' };
  if ([51, 53, 55, 56, 57].includes(code)) return { label: labels[6], icon: 'drizzle' };
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { label: labels[7], icon: 'rain' };
  if ([71, 73, 75, 77, 85, 86].includes(code)) return { label: labels[8], icon: 'snow' };
  if ([95, 96, 99].includes(code)) return { label: labels[9], icon: 'storm' };
  return { label: labels[10], icon: 'cloud' };
}
