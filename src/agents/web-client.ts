import { canOpenWebApp, openWebApp } from '../bridge';
import { agentsConnection } from './connection';
import { describe, pairingCode } from './pairing';

// POC: where the shell can host a second WebView (Fire TV), the full T3 Code
// client opens beside Luma's own agents page: the web app the paired server
// serves itself. Luma's token mints a one-time code for the server's /pair
// page, which keeps a cookie session for that origin; Luma only remembers
// which origin it already paired.
const STORAGE_KEY = 'luma.t3web.v1';
/** A session that's gone again this soon after pairing won't stick; don't loop. */
const REPAIR_GRACE_MS = 30000;
const PROBE_MS = 5000;

export const canOpenT3Code = canOpenWebApp;

let lastPath = '';
let pairedAt = 0;

/** Opens T3 Code at a path of its web app, e.g. a thread's `<environmentId>/<threadId>`. */
export async function openT3Code(path = '') {
  const { pairing, route } = agentsConnection().getState();
  if (!pairing) return;
  const server = route ?? pairing.pairedOn;
  lastPath = path;
  if (localStorage.getItem(STORAGE_KEY) === server.url) {
    openWebApp(server.url + path);
    return;
  }
  // The address may be stale or offline, and another server may answer there
  // now. Only the paired environment gets the token.
  const environment = await describe(server, PROBE_MS);
  if (environment.environmentId !== pairing.environmentId) throw new Error('wrongEnvironment');
  const code = await pairingCode(server, pairing.token, 'Luma TV (T3 Code)');
  pairedAt = Date.now();
  localStorage.setItem(STORAGE_KEY, server.url);
  openWebApp(`${server.url}pair#${new URLSearchParams({ token: code })}`, server.url + path);
}

/** The web app's session is gone (or never stuck): pair it again, once. */
export async function repairT3Code() {
  localStorage.removeItem(STORAGE_KEY);
  if (Date.now() - pairedAt < REPAIR_GRACE_MS) throw new Error('webClientRejected');
  await openT3Code(lastPath);
}

export const threadPath = (environmentId: string, threadId: string) =>
  `${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
