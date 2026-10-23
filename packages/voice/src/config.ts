import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parsePairing, type Pairing } from '../../../src/agents/pairing.ts';

// Everything the service keeps lives in ~/.config/luma/. The pairing and the
// Shortcut token are secrets, so they're written readable by Donald only.

export const configDir = (env = process.env) =>
  join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'luma');

export const files = (dir: string) => ({
  pairing: join(dir, 'voice-pairing.json'),
  token: join(dir, 'voice-token'),
  env: join(dir, 'voice.env'),
});

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function writeSecret(dir: string, path: string, text: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // `mode` only applies when the file is created, so a later write can't widen it.
  writeFileSync(path, text, { mode: 0o600 });
}

export const loadPairing = (dir: string) => parsePairing(readText(files(dir).pairing));

export const savePairing = (dir: string, pairing: Pairing) =>
  writeSecret(dir, files(dir).pairing, `${JSON.stringify(pairing, null, 2)}\n`);

/** The Shortcut's bearer token, made on first run. */
export function shortcutToken(dir: string): { token: string; created: boolean } {
  const saved = readText(files(dir).token)?.trim();
  if (saved) return { token: saved, created: false };
  const token = randomBytes(32).toString('base64url');
  writeSecret(dir, files(dir).token, `${token}\n`);
  return { token, created: true };
}

export interface Settings {
  apiKey: string | undefined;
  baseUrl: string;
  model: string;
  /** Empty for models without reasoning. */
  reasoning: string;
  host: string;
  port: number;
}

/** `KEY=value` lines; `#` starts a comment. Quotes around a value are dropped. */
export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

// The process environment wins over voice.env, so a one-off run can override it.
export function loadSettings(dir: string, env = process.env): Settings {
  const merged = { ...parseEnv(readText(files(dir).env) ?? ''), ...env };
  return {
    apiKey: merged.OPENAI_API_KEY || undefined,
    baseUrl: (merged.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: merged.LUMA_VOICE_MODEL || 'gpt-6-luna',
    reasoning: merged.LUMA_VOICE_REASONING ?? 'low',
    host: merged.LUMA_VOICE_HOST || '127.0.0.1',
    port: Number(merged.LUMA_VOICE_PORT) || 3780,
  };
}
