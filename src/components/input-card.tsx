import { ArrowUpRight } from 'lucide-react';
import { ConnectionIcon } from './connection-icon';
import type { TVInput } from '../types';
import { useTranslation } from '../i18n';

export function InputCard({
  input,
  onLaunch,
}: {
  input: TVInput;
  onLaunch: (input: TVInput) => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      className={`input-card input-${input.kind}`}
      data-focusable={`input-${input.id}`}
      onClick={() => onLaunch(input)}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') event.currentTarget.focus({ preventScroll: true });
      }}
    >
      <span className="input-art">
        <ConnectionIcon input={input} />
      </span>
      <span className="input-info">
        <span className="input-title">{input.title}</span>
        <span className="input-state">
          {input.connected === true ? (
            <>
              <i className="status-dot" />
              {t('connected')}
            </>
          ) : input.connected === false ? (
            t('noDevice')
          ) : (
            t('externalInput')
          )}
        </span>
      </span>
      <ArrowUpRight className="input-arrow" size={22} />
    </button>
  );
}
