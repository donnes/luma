import { parsePairingInput, routeFor, type Route } from './routes';

// Pairing exchanges a one-time code from T3 Code for a 30-day bearer token.
// The token belongs to the server environment, not to an address, so every
// route Luma learns later reuses it.

export const ORCHESTRATION_PROTOCOL = 2;
const STORAGE_KEY = 'luma.agents.v1';

export interface Pairing {
  environmentId: string;
  label: string;
  token: string;
  expiresAt: number;
  pairedOn: Route;
  routes: Route[];
}

export class PairingError extends Error {
  constructor(readonly code: 'unreachable' | 'incompatible' | 'rejected' | 'expired') {
    super(code);
  }
}

export interface EnvironmentDescriptor {
  environmentId: string;
  label: string;
  orchestrationProtocolVersion?: number;
}

export async function describe(route: Route, timeout: number): Promise<EnvironmentDescriptor> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${route.url}.well-known/t3/environment`, {
      signal: controller.signal,
    });
    if (!response.ok) throw new PairingError('unreachable');
    const body = await response.json();
    if (typeof body?.environmentId !== 'string') throw new PairingError('unreachable');
    return {
      environmentId: body.environmentId,
      label: typeof body.label === 'string' ? body.label : '',
      orchestrationProtocolVersion: body.orchestrationProtocolVersion,
    };
  } catch (error) {
    throw error instanceof PairingError ? error : new PairingError('unreachable');
  } finally {
    clearTimeout(timer);
  }
}

export async function pair(address: string, code: string, deviceLabel: string): Promise<Pairing> {
  const input = parsePairingInput(address, code);
  const route = routeFor(input.url);
  const environment = await describe(route, 8000);
  if (environment.orchestrationProtocolVersion !== ORCHESTRATION_PROTOCOL)
    throw new PairingError('incompatible');
  let response: Response;
  try {
    // The token endpoint only accepts form-encoded bodies.
    response = await fetch(`${route.url}oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: input.code,
        subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap',
        requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        client_label: deviceLabel,
        client_device_type: 'unknown',
      }),
    });
  } catch {
    throw new PairingError('unreachable');
  }
  if (!response.ok) throw new PairingError('rejected');
  const body = await response.json();
  if (typeof body?.access_token !== 'string') throw new PairingError('rejected');
  const pairing: Pairing = {
    environmentId: environment.environmentId,
    label: environment.label,
    token: body.access_token,
    expiresAt: Date.now() + (Number(body.expires_in) || 0) * 1000,
    pairedOn: route,
    routes: [route],
  };
  return pairing;
}

/** Mints the short-lived ticket a browser WebSocket needs, since it can't send headers. */
export async function websocketTicket(route: Route, token: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${route.url}api/auth/websocket-ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    throw new PairingError('unreachable');
  }
  if (response.status === 401 || response.status === 403) throw new PairingError('expired');
  if (!response.ok) throw new PairingError('unreachable');
  const body = await response.json();
  if (typeof body?.ticket !== 'string') throw new PairingError('unreachable');
  return body.ticket;
}

/** Issues a fresh one-time pairing code, so another client can pair without the user. */
export async function pairingCode(route: Route, token: string, label: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${route.url}api/auth/pairing-token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ label }),
    });
  } catch {
    throw new PairingError('unreachable');
  }
  if (response.status === 401) throw new PairingError('expired');
  if (!response.ok) throw new PairingError('rejected');
  const body = await response.json();
  if (typeof body?.credential !== 'string') throw new PairingError('rejected');
  return body.credential;
}

export function socketUrl(route: Route, ticket: string): string {
  const url = new URL('ws', route.url);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = new URLSearchParams({
    wsTicket: ticket,
    orchestrationProtocol: String(ORCHESTRATION_PROTOCOL),
    clientSurface: 'web',
    clientDeviceType: 'unknown',
    connectionMethod: 'direct',
  }).toString();
  return url.toString();
}

const isRoute = (value: unknown): value is Route =>
  !!value &&
  typeof (value as Route).url === 'string' &&
  /^https?:\/\//.test((value as Route).url) &&
  typeof (value as Route).kind === 'string';

/** Validates a saved pairing; the voice service keeps its own in a file. */
export function parsePairing(json: string | null): Pairing | null {
  try {
    const value = JSON.parse(json ?? 'null');
    if (
      !value ||
      typeof value.environmentId !== 'string' ||
      typeof value.token !== 'string' ||
      !isRoute(value.pairedOn) ||
      !Array.isArray(value.routes)
    )
      return null;
    const routes = value.routes.filter(isRoute);
    return {
      environmentId: value.environmentId,
      label: typeof value.label === 'string' ? value.label : '',
      token: value.token,
      expiresAt: Number(value.expiresAt) || 0,
      pairedOn: value.pairedOn,
      routes: routes.length ? routes : [value.pairedOn],
    };
  } catch {
    return null;
  }
}

export function loadPairing(): Pairing | null {
  try {
    return parsePairing(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

export function savePairing(pairing: Pairing | null) {
  try {
    if (pairing) localStorage.setItem(STORAGE_KEY, JSON.stringify(pairing));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* Storage full: the pairing still works until Luma restarts. */
  }
}
