import { memo, useCallback, useLayoutEffect, useRef } from 'react';
import type { Page } from '../types';
import { useTranslation } from '../i18n';

const tabs: { id: Page; label: 'home' | 'apps' | 'inputs' | 'settings' }[] = [
  { id: 'home', label: 'home' },
  { id: 'apps', label: 'apps' },
  { id: 'inputs', label: 'inputs' },
  { id: 'settings', label: 'settings' },
];

export const Navigation = memo(function Navigation({
  page,
  onChange,
}: {
  page: Page;
  onChange: (page: Page) => void;
}) {
  const { t } = useTranslation();
  const navigation = useRef<HTMLElement>(null);
  const indicator = useRef<HTMLSpanElement>(null);
  const positioned = useRef(false);
  const positionIndicator = useCallback((animate: boolean) => {
    const selected = navigation.current?.querySelector<HTMLElement>('[aria-current="page"]');
    const pill = indicator.current;
    if (!selected || !pill) return;
    // Measure only when selecting a tab or resizing. CSS owns every animation frame.
    pill.style.transition = animate ? '' : 'none';
    const left = selected.offsetLeft;
    const width = selected.offsetWidth;
    pill.style.width = `${width}px`;
    pill.style.transform = `translateX(${left}px)`;
  }, []);

  useLayoutEffect(() => {
    positionIndicator(positioned.current);
    positioned.current = true;
  }, [page, positionIndicator]);

  useLayoutEffect(() => {
    const element = navigation.current;
    if (!element) return;
    // Font loading and responsive styles can change the individual tab widths.
    const observer = new ResizeObserver(() => positionIndicator(false));
    observer.observe(element);
    element.querySelectorAll('button').forEach((tab) => observer.observe(tab));
    return () => observer.disconnect();
  }, [positionIndicator]);

  return (
    <nav ref={navigation} className="navigation" aria-label={t('mainNavigation')}>
      <span ref={indicator} className="nav-indicator" aria-hidden="true" />
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={`nav-item${page === tab.id ? ' active' : ''}`}
          data-focusable={`nav-${tab.id}`}
          aria-current={page === tab.id ? 'page' : undefined}
          onClick={() => onChange(tab.id)}
        >
          <span>{t(tab.label)}</span>
        </button>
      ))}
    </nav>
  );
});
