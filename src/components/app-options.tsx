import { ArrowLeftRight, Eye, EyeOff, Heart } from 'lucide-react';
import type { PointerEvent } from 'react';
import { Dialog } from './dialog';
import type { TVApp } from '../types';
import { categoryLabel, useTranslation } from '../i18n';

interface Props {
  app: TVApp;
  favorites: string[];
  hidden: boolean;
  onClose: () => void;
  onPin: () => void;
  onHide: () => void;
  /** Starts moving the app among the favorites on Home. */
  onMove?: () => void;
}

function focusAction(event: PointerEvent<HTMLButtonElement>) {
  if (event.pointerType === 'mouse') event.currentTarget.focus({ preventScroll: true });
}

export function AppOptions({ app, favorites, hidden, onClose, onPin, onHide, onMove }: Props) {
  const { t, language } = useTranslation();
  const pinned = favorites.includes(app.id);
  return (
    <Dialog title={app.title} subtitle={categoryLabel(language, app.category)} onClose={onClose}>
      <div className="settings-group app-actions">
        <button
          className="setting-row"
          data-focusable="option-pin"
          data-autofocus="true"
          onPointerEnter={focusAction}
          onClick={onPin}
        >
          <Heart fill={pinned ? 'currentColor' : 'none'} />
          <span>
            <strong>{t(pinned ? 'removeFavorite' : 'addFavorite')}</strong>
          </span>
        </button>
        {onMove ? (
          <button
            className="setting-row"
            data-focusable="option-move"
            onPointerEnter={focusAction}
            onClick={onMove}
          >
            <ArrowLeftRight />
            <span>
              <strong>{t('move')}</strong>
            </span>
          </button>
        ) : null}
        <button
          className="setting-row"
          data-focusable="option-hide"
          onPointerEnter={focusAction}
          onClick={onHide}
        >
          {hidden ? <Eye /> : <EyeOff />}
          <span>
            <strong>{t(hidden ? 'showApp' : 'hideApp')}</strong>
          </span>
        </button>
      </div>
    </Dialog>
  );
}
