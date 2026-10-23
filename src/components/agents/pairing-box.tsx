import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { KeyRound, Link2, LoaderCircle, Server } from 'lucide-react';
import { useAgents } from '../../agents/use-agents';
import { useTranslation, type MessageKey } from '../../i18n';
import { isBackKey } from '../../navigation';
import { T3Glyph } from './agents-mark';

const pairingErrors: Record<string, MessageKey> = {
  missingAddress: 'agentsErrorAddress',
  invalidAddress: 'agentsErrorAddress',
  missingCode: 'agentsErrorCode',
  unreachable: 'agentsErrorUnreachable',
  incompatible: 'agentsErrorIncompatible',
  rejected: 'agentsErrorRejected',
};

// Back leaves the field instead of the page, like the weather city search.
const stopEscape = (event: KeyboardEvent<HTMLInputElement>) => {
  if (isBackKey(event)) {
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) event.currentTarget.blur();
  }
};

/** What the T3 Code app shows until it's paired, or after the pairing expires. */
export function PairingBox({ onPaired }: { onPaired: () => void }) {
  const { t } = useTranslation();
  const { state, connection } = useAgents();
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState('');
  const expired = state.status === 'expired';
  const message = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (error) message.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [error]);

  const submit = async () => {
    setPairing(true);
    setError('');
    try {
      await connection.pair(address, code, 'Luma TV');
      onPaired();
    } catch (cause) {
      setError(
        t(pairingErrors[cause instanceof Error ? cause.message : ''] ?? 'agentsErrorUnreachable'),
      );
      setPairing(false);
    }
  };

  return (
    <section className="pairing" aria-labelledby="pairing-title">
      <div className="pairing-copy">
        <T3Glyph className="pairing-glyph" />
        <h1 id="pairing-title">{t(expired ? 'agentsExpiredTitle' : 'agentsPairTitle')}</h1>
        <p>{t(expired ? 'agentsExpiredBody' : 'agentsPairBody')}</p>
        <ol className="pairing-steps">
          <li>{t('agentsPairStep1')}</li>
          <li>{t('agentsPairStep2')}</li>
        </ol>
      </div>
      <form
        className="pairing-panel"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="pairing-field">
          <span>{t('agentsAddress')}</span>
          <span className="search-field">
            <Server />
            <input
              data-focusable="agents-address"
              aria-label={t('agentsAddress')}
              placeholder={t('agentsAddressPlaceholder')}
              value={address}
              inputMode="url"
              autoComplete="off"
              onKeyDown={stopEscape}
              onChange={(event) => setAddress(event.target.value)}
            />
          </span>
        </label>
        <label className="pairing-field">
          <span>{t('agentsCode')}</span>
          <span className="search-field">
            <KeyRound />
            <input
              data-focusable="agents-code"
              aria-label={t('agentsCode')}
              placeholder={t('agentsCodePlaceholder')}
              value={code}
              autoComplete="off"
              autoCapitalize="characters"
              maxLength={20}
              onKeyDown={stopEscape}
              onChange={(event) => setCode(event.target.value)}
            />
          </span>
        </label>
        <button
          className="pill pill-primary pairing-submit"
          type="submit"
          data-focusable="agents-pair"
          disabled={pairing || !address.trim()}
        >
          {pairing ? <LoaderCircle className="spin" /> : <Link2 />}
          <span>{t('agentsPair')}</span>
        </button>
        {error ? (
          <p ref={message} className="pairing-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </section>
  );
}
