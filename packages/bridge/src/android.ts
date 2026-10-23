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
  openWebApp?(url: string, then: string): void;
  canAlertOverApps?(): boolean;
  watchAgents?(config: string): void;
}

const shell = (): LumaShell | undefined =>
  typeof window === 'undefined' ? undefined : (window as any).LumaAndroid;

export const isTV = (): boolean => {
  const host = shell();
  return !!host && host.isTV() === true;
};

// Fire OS lists its own tools and Amazon storefronts (News, Silk, miniTV,
// Appstore, Downloads, the screensaver…) as launchable apps. The library keeps
// the streaming apps: every third-party app plus Amazon's Prime Video and YouTube.
const amazonStreaming = new Set([
  'com.amazon.firebat',
  'com.amazon.avod',
  'com.amazon.firetv.youtube',
]);

export function streamingApps(raw: unknown[]): unknown[] {
  return raw.filter((entry) => {
    if (typeof entry !== 'object' || entry === null || !('id' in entry)) return false;
    const { id } = entry;
    if (typeof id !== 'string') return false;
    return amazonStreaming.has(id) || !/^(com\.amazon\.|amazon\.|com\.android\.)/.test(id);
  });
}

export async function loadInventory(): Promise<Inventory> {
  const host = shell();
  if (!host) throw new Error('The Android TV shell is unavailable.');
  const raw = JSON.parse(host.listApps());
  return {
    apps: normalizeApps(streamingApps(Array.isArray(raw?.apps) ? raw.apps : [])),
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

// POC: hosts a web app (T3 Code's own client) in a second shell WebView.
export const canOpenWebApp = (): boolean => typeof shell()?.openWebApp === 'function';

/** `then` loads once the first page has left /pair, so pairing can land on a deep link. */
export function openWebApp(url: string, then = ''): void {
  shell()?.openWebApp?.(url, then);
}

// Fire TV: with HomeGuard enabled, the shell keeps its own connection to the
// paired T3 Code server, since the low-memory killer soon takes this page
// once another app is in front. It alerts over that app when an agent newly
// needs you and, while Luma is in front, sends the alert here as an event.
export const canAlertOverApps = (): boolean => shell()?.canAlertOverApps?.() === true;

export interface AgentWatch {
  /** The paired server; a route answering as another one is skipped. */
  environmentId: string;
  /** Server origins, best first. */
  routes: string[];
  token: string;
  /** The server's name, shown top right. */
  source: string;
  /** Headlines, in the user's language: "Needs you · asked a question". */
  asked: string;
  approval: string;
}

/**
 * Hands the shell the pairing to watch agents with; null once unpaired. The
 * shell keeps it whether HomeGuard is on or not.
 */
export function watchAgents(config: AgentWatch | null): void {
  shell()?.watchAgents?.(config ? JSON.stringify(config) : '');
}

/** The shell's alerts while Luma is in front; `detail` is an alert like AgentToast's. */
export const AGENT_ALERT_EVENT = 'luma:agent-alert';
