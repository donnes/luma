export type Page = 'home' | 'apps' | 'inputs' | 'settings';
export type Wallpaper =
  | 'dunes'
  | 'san-francisco'
  | 'midnight'
  | 'summit'
  | 'slate'
  | 'forest'
  | 'prism'
  | 'yosemite'
  | 'northern-lights';
export type Category = 'Streaming' | 'Music' | 'Gaming' | 'Utilities';
export type TemperatureUnit = 'celsius' | 'fahrenheit';

export interface TVApp {
  id: string;
  title: string;
  category: Category;
  brand: string;
}

export interface TVInput {
  id: string;
  title: string;
  port: string;
  connected: boolean | null;
  kind: 'console' | 'streamer' | 'computer' | 'hdmi';
}

export interface Preferences {
  version: 1;
  favorites: string[] | null;
  hidden: string[];
  recent: string[];
  wallpaper: Wallpaper;
  reducedMotion: boolean;
  clock24: boolean;
  showHomeAppNames: boolean;
  showWeather: boolean;
  temperatureUnit: TemperatureUnit;
  weatherLocation: WeatherLocation | null;
}

export interface WeatherLocation {
  name: string;
  region: string;
  country: string;
  latitude: number;
  longitude: number;
}

export interface WeatherReading {
  // API readings and cached temperatures are always Celsius.
  temperature: number;
  code: number;
  isDay: boolean;
}

export interface Inventory {
  apps: TVApp[];
  inputs: TVInput[];
  warnings: string[];
}

export interface NativeBridge {
  onservicecallback: (raw: string) => void;
  call(uri: string, payload: string): void;
  cancel(): void;
}

declare global {
  interface Window {
    PalmServiceBridge?: new () => NativeBridge;
    webOSServiceBridge?: new () => NativeBridge;
    PalmSystem?: { identifier?: string; platformBack?: () => void };
    webOSSystem?: { identifier?: string; platformBack?: () => void };
  }
}
