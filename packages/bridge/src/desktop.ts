import { demoApps, demoInputs } from './catalog';
import type { Inventory } from './types';

// Browser preview: the same UI runs with sample inventory and no TV actions.
export const isTV = (): boolean => false;

export async function loadInventory(): Promise<Inventory> {
  return { apps: demoApps, inputs: demoInputs, warnings: [] };
}

export async function launchApp(): Promise<void> {
  // Launches are TV-only; the preview shows a message instead.
}

export function platformBack(): void {
  window.history.back();
}
