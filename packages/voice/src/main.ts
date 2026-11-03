import { pair, PairingError } from '../../../src/agents/pairing.ts';
import { createAssistant } from './assistant.ts';
import {
  configDir,
  files,
  loadPairing,
  loadSettings,
  savePairing,
  shortcutToken,
} from './config.ts';
import { createVoiceServer } from './server.ts';

// pnpm voice                       serve the Shortcut
// pnpm voice pair <address> <code> pair with T3 Code once
// pnpm voice token                 show the Shortcut's token again

const dir = configDir();
const [command = 'serve', ...rest] = process.argv.slice(2);

const pairingErrors: Record<PairingError['code'], string> = {
  unreachable: "Couldn't reach T3 Code at that address.",
  incompatible: 'That T3 Code server speaks a different protocol version than Luma.',
  rejected: 'T3 Code rejected the code. Codes work once and expire after 5 minutes.',
  expired: 'The pairing expired.',
};

async function pairCommand(address: string | undefined, code = '') {
  if (!address) {
    console.error('Usage: pnpm voice pair <address> <code>, or pnpm voice pair "<pairing link>"');
    process.exit(1);
  }
  try {
    const pairing = await pair(address, code, 'Luma Voice');
    savePairing(dir, pairing);
    const days = Math.round((pairing.expiresAt - Date.now()) / 86400000);
    console.log(
      `Paired with ${pairing.label || 'T3 Code'}. The session lasts ${days} days. Saved to ${files(dir).pairing}`,
    );
  } catch (error) {
    console.error(
      error instanceof PairingError
        ? pairingErrors[error.code]
        : `Couldn't pair: ${error instanceof Error ? error.message : error}`,
    );
    process.exit(1);
  }
}

function serve() {
  const settings = loadSettings(dir);
  const { apiKey } = settings;
  if (!apiKey) {
    console.error(`Set OPENAI_API_KEY in ${files(dir).env} or the environment, then start again.`);
    process.exit(1);
  }
  const { token, created } = shortcutToken(dir);
  const pairing = loadPairing(dir);
  if (!pairing) console.warn('Not paired with T3 Code yet. Run: pnpm voice pair <address> <code>');
  if (created)
    console.log(
      `Created the Shortcut's token in ${files(dir).token}:\n\n  ${token}\n\nPut it in the Shortcut's Authorization header as "Bearer <token>". See packages/voice/README.md.\n`,
    );

  const server = createVoiceServer({
    token,
    // Read the pairing for every request, so re-pairing doesn't need a restart.
    handle: createAssistant({
      openai: { ...settings, apiKey },
      pairing: () => loadPairing(dir),
    }),
  });
  server.listen(settings.port, settings.host, () =>
    console.log(
      `Luma voice is listening on http://${settings.host}:${settings.port}/voice using ${settings.model}.`,
    ),
  );
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (command === 'pair') await pairCommand(rest[0], rest[1]);
else if (command === 'token') console.log(shortcutToken(dir).token);
else if (command === 'serve') serve();
else {
  console.error(`Unknown command "${command}". Use serve, pair or token.`);
  process.exit(1);
}
