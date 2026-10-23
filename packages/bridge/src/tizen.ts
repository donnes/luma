import { normalizeApps } from './catalog';
import type { Inventory } from './types';

// Samsung Tizen TVs (2015+, Tizen 2.3–10). The tizen namespace is injected by
// the TV's web runtime; no rooting or elevated services are involved.
/* eslint-disable @typescript-eslint/no-explicit-any -- The Tizen SDK has no bundled types here. */

export const isTV = (): boolean =>
  typeof window !== 'undefined' && !!(window as any).tizen?.application;

export async function loadInventory(): Promise<Inventory> {
  const tizen = (window as any).tizen;
  const apps = await new Promise<any[]>((resolve, reject) => {
    try {
      tizen.application.getAppsInfo(
        (list: any[]) => resolve(list ?? []),
        (error: unknown) => reject(new Error(tizenError(error))),
      );
    } catch (error) {
      reject(new Error(tizenError(error)));
    }
  });
  return {
    apps: normalizeApps(
      apps.map((app) => ({
        id: app.appId,
        title: app.name ?? app.appId,
        visible: !app.hidden,
      })),
    ),
    inputs: [],
    warnings: [
      'HDMI inputs are not available from a Tizen application. Launch apps and use your remote’s Source key for inputs.',
    ],
  };
}

export async function launchApp(id: string): Promise<void> {
  const tizen = (window as any).tizen;
  await new Promise<void>((resolve, reject) => {
    try {
      tizen.application.launch(
        id,
        () => resolve(),
        (error: unknown) => reject(new Error(tizenError(error))),
      );
    } catch (error) {
      reject(new Error(tizenError(error)));
    }
  });
}

// Back, OK and the arrows reach every app; other remote keys only reach apps
// that register them. Tools and the red key open the inbox: Smart Remotes have
// neither Menu nor Tools, but reach the red key from their on-screen keypad.
// Registering a key this TV doesn't support throws, so check the list first.
export function registerRemoteKeys(): void {
  try {
    const input = (window as any).tizen.tvinputdevice;
    const supported = new Set(input.getSupportedKeys().map((key: { name: string }) => key.name));
    for (const name of ['Tools', 'ColorF0Red']) if (supported.has(name)) input.registerKey(name);
  } catch {
    // Older firmware without tvinputdevice keeps the default keys.
  }
}

export function platformBack(): void {
  try {
    (window as any).tizen.application.getCurrentApplication().exit();
  } catch {
    window.history.back();
  }
}

function tizenError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error)
    return String((error as { message?: unknown }).message);
  if (typeof error === 'string') return error;
  return 'The TV denied this action.';
}
