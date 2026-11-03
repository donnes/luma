import type { DirectEndpoint } from './types';

// The same environment is often reachable at several addresses: the LAN, the
// Tailscale IP and a Tailscale Serve HTTPS name. The ranking and the rules for
// learning addresses follow T3 Code's client-runtime/src/connection/routes.ts.

export type RouteKind = 'loopback' | 'lan' | 'tailnet' | 'vpn' | 'public';

export interface Route {
  /** Origin with a trailing slash, e.g. `http://192.168.1.10:3773/`. */
  url: string;
  kind: RouteKind;
}

const rank: Record<RouteKind, number> = { loopback: 0, lan: 1, tailnet: 2, vpn: 2, public: 3 };

function ipv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : null;
}

export function routeKind(url: URL, reportedKind?: DirectEndpoint['kind']): RouteKind {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host.startsWith('127.')) return 'loopback';
  if (host.endsWith('.ts.net') || host.startsWith('fd7a:115c:a1e0:')) return 'tailnet';
  const ip = ipv4(host);
  // 100.64.0.0/10 is shared by every CGNAT VPN; only trust it as Tailscale when
  // the server says the address is on its Tailscale interface.
  if (ip && ip[0] === 100 && ip[1] >= 64 && ip[1] < 128)
    return reportedKind === 'tailnet' ? 'tailnet' : 'vpn';
  if (
    (ip &&
      (ip[0] === 10 ||
        (ip[0] === 172 && ip[1] >= 16 && ip[1] < 32) ||
        (ip[0] === 192 && ip[1] === 168))) ||
    host.endsWith('.local') ||
    /^f[cd][0-9a-f]{2}:/.test(host)
  )
    return 'lan';
  return reportedKind === 'tailnet' ? 'tailnet' : 'public';
}

export const sortRoutes = (routes: Route[]) =>
  [...routes].sort((a, b) => rank[a.kind] - rank[b.kind]);

export interface PairingInput {
  url: string;
  code: string;
}

// Accepts a full pairing link (`http://host:3773/pair#token=…`), or an address
// plus the 12-character code from T3 Code's Connections settings.
export function parsePairingInput(address: string, code: string): PairingInput {
  let raw = address.trim();
  if (!raw) throw new Error('missingAddress');
  if (!/^https?:\/\//i.test(raw))
    raw = `${/\.ts\.net(?::\d+)?(?:\/|$)/i.test(raw) ? 'https' : 'http'}://${raw}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('invalidAddress');
  }
  const fromLink =
    new URLSearchParams(url.hash.slice(1)).get('token') ?? url.searchParams.get('token');
  const token = (fromLink ?? code).replace(/[\s-]/g, '').toUpperCase();
  if (!token) throw new Error('missingCode');
  return { url: `${url.origin}/`, code: token };
}

/**
 * Merges the server's advertised addresses into the saved routes.
 *
 * A token is never sent in clear to an address it wasn't already exposed on:
 * a token paired over HTTPS or Tailscale only learns HTTPS and Tailscale
 * addresses. Plain HTTP is dropped entirely when Luma itself is served over
 * HTTPS, where the browser would block it as mixed content.
 */
export function learnRoutes(
  routes: Route[],
  endpoints: DirectEndpoint[],
  pairedOn: Route,
  pageIsHttps: boolean,
): Route[] {
  const tokenSeenInClear =
    pairedOn.url.startsWith('http:') && (pairedOn.kind === 'lan' || pairedOn.kind === 'public');
  const known = new Set(routes.map((route) => route.url));
  const learned: Route[] = [];
  for (const endpoint of endpoints) {
    let url: URL;
    try {
      url = new URL(endpoint.httpBaseUrl);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    const kind = routeKind(url, endpoint.kind);
    const route = { url: `${url.origin}/`, kind };
    if (kind === 'loopback' || known.has(route.url)) continue;
    if (url.protocol === 'http:' && (pageIsHttps || (kind !== 'tailnet' && !tokenSeenInClear)))
      continue;
    known.add(route.url);
    learned.push(route);
  }
  return learned.length ? sortRoutes([...routes, ...learned]) : routes;
}

export const routeFor = (url: string): Route => ({ url, kind: routeKind(new URL(url)) });
