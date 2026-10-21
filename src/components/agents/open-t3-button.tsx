import { useAgents } from '../../agents/use-agents';
import { canOpenT3Code, openT3Code } from '../../agents/web-client';
import { useTranslation } from '../../i18n';
import { T3Glyph } from './agents-mark';

/** Beside the connection status: leaves Luma's page for the full T3 Code app. */
export function OpenT3Button({ notify }: { notify: (text: string, error?: boolean) => void }) {
  const { t } = useTranslation();
  const { state } = useAgents();
  if (!canOpenT3Code() || !state.pairing || state.status === 'expired') return null;
  return (
    <button
      className="icon-button open-t3-button"
      data-focusable="agents-open-t3"
      onClick={() => void openT3Code().catch(() => notify(t('agentsWebFailed'), true))}
    >
      <T3Glyph />
      {t('agentsOpenT3')}
    </button>
  );
}
