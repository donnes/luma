import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from '../i18n';

export function Dialog({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
  footerEnd,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  footerEnd?: ReactNode;
}) {
  const { t } = useTranslation();
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const apps = [...document.querySelectorAll<HTMLElement>('main [data-app-id]')];
    const index = previous ? apps.indexOf(previous) : -1;
    const neighbors =
      index < 0 ? [] : [...apps.slice(index + 1), ...apps.slice(0, index).reverse()];
    const returnIds = [
      previous?.dataset.focusable,
      ...neighbors.map((node) => node.dataset.focusable),
    ];
    (
      panel.current?.querySelector<HTMLElement>('[data-autofocus]') ??
      panel.current?.querySelector<HTMLElement>('[data-focusable]')
    )?.focus({ preventScroll: true });
    return () => {
      // Restore after React has finished moving/removing the affected app cards.
      queueMicrotask(() => {
        if (document.querySelector('[data-focus-scope="dialog"]')) return;
        let target: HTMLElement | null = null;
        for (const id of returnIds) {
          if (!id) continue;
          const node = document.querySelector<HTMLElement>(`[data-focusable="${CSS.escape(id)}"]`);
          if (node && !node.hasAttribute('disabled')) {
            target = node;
            break;
          }
        }
        target ??= document.querySelector<HTMLElement>('main [data-focusable]');
        target?.focus({ preventScroll: true });
        target?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      });
    };
  }, []);
  return (
    <div
      className="dialog-scrim"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        data-focus-scope="dialog"
        className={`dialog${wide ? ' dialog-wide' : ''}`}
      >
        <div className="dialog-heading">
          <div>
            <h2 id="dialog-title">{title}</h2>
            {subtitle ? <p className="dialog-subtitle">{subtitle}</p> : null}
          </div>
          <button
            className="icon-button close-button"
            aria-label={t('closeDialog')}
            data-focusable="dialog-close"
            onPointerEnter={(event) => {
              if (event.pointerType === 'mouse') event.currentTarget.focus({ preventScroll: true });
            }}
            onClick={onClose}
          >
            <X />
          </button>
        </div>
        {children}
        <div className="dialog-footer">
          <div className="dialog-shortcuts">
            <span className="keycap">OK</span> {t('selectClose')}{' '}
            <span className="keycap">Back</span> {t('close')}
          </div>
          {footerEnd ? <div className="dialog-footer-end">{footerEnd}</div> : null}
        </div>
      </div>
    </div>
  );
}
