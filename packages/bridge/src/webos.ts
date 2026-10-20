import { demoApps, demoInputs, normalizeApps, normalizeInputs, validAppId } from './catalog';
import type { Inventory, NativeBridge } from './types';

const active = new Set<NativeBridge>();
export const isTV = () =>
  typeof window !== 'undefined' &&
  !!(window.PalmSystem || window.webOSSystem) &&
  !!(window.PalmServiceBridge || window.webOSServiceBridge);
const manager = 'luna://com.webos.applicationManager/';

export function nativeCall(
  uri: string,
  payload: Record<string, unknown>,
  timeout = 6500,
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const Bridge = window.PalmServiceBridge ?? window.webOSServiceBridge;
    if (!Bridge) {
      reject(new Error('This action is available on the TV.'));
      return;
    }
    let bridge: NativeBridge | undefined;
    let timer: ReturnType<typeof setTimeout>;
    let done = false;
    const finish = (error: Error | null, result?: Record<string, any>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (bridge) {
        active.delete(bridge);
        bridge.onservicecallback = () => {};
        try {
          bridge.cancel();
        } catch {
          /* Native object may already be closed. */
        }
      }
      if (error) reject(error);
      else resolve(result!);
    };
    timer = setTimeout(
      () =>
        finish(
          new Error(
            'The TV did not respond. Check Homebrew Channel’s root status, then try again.',
          ),
        ),
      timeout,
    );
    try {
      bridge = new Bridge();
      active.add(bridge);
      bridge.onservicecallback = (raw) => {
        try {
          if (typeof raw !== 'string' || raw.length > 2 * 1024 * 1024)
            throw new Error('The TV returned an unreadable response.');
          const value = JSON.parse(raw);
          if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error('The TV returned an unreadable response.');
          if (
            value.returnValue !== true ||
            (value.errorCode !== undefined && value.errorCode !== 0 && value.errorCode !== '0')
          ) {
            throw new Error(
              typeof value.errorText === 'string'
                ? value.errorText.slice(0, 240)
                : 'The TV denied this action.',
            );
          }
          finish(null, value);
        } catch (error) {
          finish(
            error instanceof Error ? error : new Error('The TV returned an unreadable response.'),
          );
        }
      };
      bridge.call(uri, JSON.stringify(payload));
    } catch {
      finish(new Error('The webOS service bridge is unavailable.'));
    }
  });
}

async function inventoryRead(uri: string, field: string): Promise<unknown> {
  // Read private inventory APIs through the existing elevated Homebrew service.
  // No credentials or environment reads.
  const command = `if [ "$(id -u)" = "0" ]; then /usr/bin/luna-send -n 1 -w 4000 ${uri} '{}'; else printf '%s\\n' '{"returnValue":false,"errorText":"Homebrew Channel needs root access."}'; fi`;
  const envelope = await nativeCall('luna://org.webosbrew.hbchannel.service/exec', { command });
  if (
    [envelope.returnCode, envelope.exitCode].some(
      (code) => code !== undefined && code !== 0 && code !== '0',
    ) ||
    envelope.error ||
    envelope.stderrString
  )
    throw new Error('Homebrew Channel could not read the TV inventory. Check its root status.');
  if (typeof envelope.stdoutString !== 'string' || envelope.stdoutString.length > 2 * 1024 * 1024)
    throw new Error('Homebrew Channel returned no inventory.');
  const response = JSON.parse(envelope.stdoutString);
  if (response?.returnValue !== true || !Array.isArray(response[field]))
    throw new Error(response?.errorText || 'The TV did not return its inventory.');
  return response[field];
}

export async function loadInventory(): Promise<Inventory> {
  if (!isTV()) return { apps: demoApps, inputs: demoInputs, warnings: [] };
  const [apps, inputs] = await Promise.allSettled([
    inventoryRead(`${manager}listApps`, 'apps').then(normalizeApps),
    inventoryRead('luna://com.webos.service.eim/getAllInputStatus', 'devices').then(
      normalizeInputs,
    ),
  ]);
  if (apps.status === 'rejected')
    throw new Error(
      `Couldn’t load your apps. ${apps.reason instanceof Error ? apps.reason.message : 'Check Homebrew Channel’s root status.'}`,
    );
  return {
    apps: apps.value,
    inputs: inputs.status === 'fulfilled' ? inputs.value : [],
    warnings:
      inputs.status === 'rejected' ? ['Inputs couldn’t be loaded. Refresh to try again.'] : [],
  };
}

export async function launchApp(id: string): Promise<void> {
  if (!validAppId(id)) throw new Error('This app has an invalid identifier.');
  if (!isTV()) return;
  const status = await nativeCall(`${manager}getAppLoadStatus`, { appId: id });
  if (status.exist !== true)
    throw new Error('This app is no longer installed. Refresh your library.');
  // Public API + declared ACGs, rather than rewriting any system permissions.
  await nativeCall(`${manager}launch`, { id });
}

export function platformBack(): void {
  const system = window.PalmSystem ?? window.webOSSystem;
  system?.platformBack?.();
}
