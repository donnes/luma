import { useEffect, useState } from 'react';
import { localeFor, translate } from '../i18n';
import type { Language } from '../types';

const formatTime = (now: Date, clock24: boolean, locale: string) =>
  new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: !clock24,
  }).format(now);
const formatDate = (now: Date, locale: string) =>
  new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric' }).format(now);

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (!document.hidden) timer = setTimeout(tick, 60000 - (Date.now() % 60000));
    };
    const tick = () => {
      if (!document.hidden) setNow(new Date());
      schedule();
    };
    schedule();
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('webOSRelaunch', tick);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('webOSRelaunch', tick);
    };
  }, []);
  return now;
}

export function Clock({ clock24, language }: { clock24: boolean; language: Language }) {
  const now = useClock();
  return (
    <time className="header-time" dateTime={now.toISOString()}>
      {formatTime(now, clock24, localeFor(language))}
    </time>
  );
}

export function Greeting({ language }: { language: Language }) {
  const now = useClock();
  const hour = now.getHours();
  const greeting =
    hour < 5 ? 'greetingNight' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  return (
    <>
      <p className="eyebrow hero-date">{formatDate(now, localeFor(language))}</p>
      <h1 id="greeting">{translate(language, greeting)}</h1>
    </>
  );
}

export function AmbientClock({ clock24, language }: { clock24: boolean; language: Language }) {
  const now = useClock();
  return (
    <>
      <span className="ambient-date">{formatDate(now, localeFor(language))}</span>
      <span className="ambient-time">{formatTime(now, clock24, localeFor(language))}</span>
    </>
  );
}
