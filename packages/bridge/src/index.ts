import type { Inventory } from './types';
import { validAppId } from './catalog';
import * as webos from './webos';
import * as tizen from './tizen';
import * as android from './android';
import * as desktop from './desktop';

export * from './types';
export * from './catalog';
export { nativeCall } from './webos';
export { canOpenWebApp, openWebApp } from './android';

// Ordered by detection confidence: webOS exposes service bridges, Tizen exposes
// the tizen namespace, and Android/Fire TV exposes an injected shell object.
function platform(): typeof webos {
  if (webos.isTV()) return webos;
  if (tizen.isTV()) return tizen as unknown as typeof webos;
  if (android.isTV()) return android as unknown as typeof webos;
  return desktop as unknown as typeof webos;
}

export function isTV(): boolean {
  return platform().isTV();
}

export async function loadInventory(): Promise<Inventory> {
  return platform().loadInventory();
}

export async function launchApp(id: string): Promise<void> {
  if (!validAppId(id)) throw new Error('This app has an invalid identifier.');
  return platform().launchApp(id);
}

export function platformBack(): void {
  return platform().platformBack();
}

/** Asks the platform to deliver the remote keys Luma uses beyond the defaults. */
export function registerRemoteKeys(): void {
  if (tizen.isTV()) tizen.registerRemoteKeys();
}
