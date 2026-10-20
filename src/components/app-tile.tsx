import { memo, useEffect, useRef } from 'react';
import { ArrowLeft, ArrowRight, Heart, LoaderCircle } from 'lucide-react';
import { Brand } from './brand';
import type { TVApp } from '../types';
import { useTranslation } from '../i18n';

interface Props {
  app: TVApp;
  prefix: string;
  pinned?: boolean;
  launching?: boolean;
  reordering?: boolean;
  onLaunch: (app: TVApp) => void;
  onOptions: (app: TVApp) => void;
  onHold?: (app: TVApp) => void;
}

export const AppTile = memo(function AppTile({
  app,
  prefix,
  pinned,
  launching,
  reordering,
  onLaunch,
  onOptions,
  onHold,
}: Props) {
  const { t } = useTranslation();
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const held = useRef(false);
  useEffect(() => () => clearTimeout(hold.current), []);
  const clearHold = () => {
    clearTimeout(hold.current);
  };
  return (
    <button
      className="app-tile"
      data-focusable={`${prefix}-${app.id}`}
      data-app-id={app.id}
      data-reordering={reordering || undefined}
      aria-label={`${t(reordering ? 'move' : 'open')} ${app.title}`}
      aria-haspopup={reordering ? undefined : 'dialog'}
      aria-describedby={reordering ? 'reorder-instructions' : undefined}
      onBlur={clearHold}
      onPointerEnter={(event) => {
        if (event.currentTarget.closest('.is-reordering')) return;
        if (event.pointerType === 'mouse') event.currentTarget.focus({ preventScroll: true });
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        if (!reordering && event.currentTarget.closest('.is-reordering')) {
          event.preventDefault();
          return;
        }
        held.current = false;
        hold.current = setTimeout(() => {
          held.current = true;
          (onHold ?? onOptions)(app);
        }, 600);
      }}
      onPointerUp={clearHold}
      onPointerCancel={clearHold}
      onPointerLeave={clearHold}
      onContextMenu={(event) => {
        event.preventDefault();
        clearHold();
        onOptions(app);
      }}
      onClick={() => {
        clearHold();
        if (held.current) {
          held.current = false;
          return;
        }
        onLaunch(app);
      }}
    >
      <span className={`app-face brand-${app.brand}`}>
        <Brand app={app} />
        {pinned ? (
          <Heart
            className="favorite-badge"
            size={16}
            fill="currentColor"
            strokeWidth={0}
            aria-label={t('favorite')}
          />
        ) : null}
        {reordering ? (
          <span className="reorder-indicator" aria-hidden="true">
            <ArrowLeft size={16} />
            <ArrowRight size={16} />
          </span>
        ) : null}
        {launching ? (
          <span className="launch-overlay">
            <LoaderCircle className="spin" />
          </span>
        ) : null}
      </span>
      <span className="app-label">{app.title}</span>
    </button>
  );
});
