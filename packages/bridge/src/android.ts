import { normalizeApps } from './catalog';
import type { Inventory } from './types';

// Android TV and Fire TV sticks run Luma in a WebView shell. The shell
// injects window.LumaAndroid with a small synchronous JSON interface.
/* eslint-disable @typescript-eslint/no-explicit-any -- The shell interface is host-provided. */

interface LumaShell {
  isTV(): boolean;
  listApps(): string;
  launchApp(appId: string): string;
  exit(): void;
}

const shell = (): LumaShell | undefined =>
  typeof window === 'undefined' ? undefined : (window as any).LumaAndroid;

export const isTV = (): boolean => {
  const host = shell();
  return !!host && host.isTV() === true;
};

export async function loadInventory(): Promise<Inventory> {
  const host = shell();
  if (!host) throw new Error('The Android TV shell is unavailable.');
  const raw = JSON.parse(host.listApps());
  return {
    apps: normalizeApps(Array.isArray(raw?.apps) ? raw.apps : []),
    inputs: [],
    warnings: [
      'HDMI inputs are not available on a streaming stick. Launch apps with the stick’s own home screen for inputs.',
    ],
  };
}

export async function launchApp(id: string): Promise<void> {
  const host = shell();
  if (!host) throw new Error('The Android TV shell is unavailable.');
  const result: unknown = JSON.parse(host.launchApp(id) || '{}');
  if ((result as any)?.error) throw new Error(String((result as any).error));
}

export function platformBack(): void {
  const host = shell();
  if (host) host.exit();
  else window.history.back();
}
