import type { ProjectShell } from '../../agents/types';

const gradients = ['slate', 'green', 'violet', 'orange', 'blue', 'rose'];

/** A stable colour and initials for a project, like an app icon it doesn't have. */
export function projectMark(project: ProjectShell | undefined) {
  const title = project?.title ?? '?';
  let hash = 0;
  for (const char of project?.id ?? title) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const words = title.split(/[\s._-]+/).filter(Boolean);
  const initials =
    title.toLowerCase().startsWith('t3') || words.length < 2
      ? title.slice(0, title.toLowerCase().startsWith('t3') ? 2 : 1)
      : `${words[0][0]}${words[1][0]}`;
  return {
    initials: initials.toUpperCase(),
    tone: gradients[Math.abs(hash) % gradients.length],
  };
}

export function elapsed(iso: string | undefined, locale: string, now = Date.now()): string {
  if (!iso) return '';
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  if (seconds < 60) return format.format(0, 'second');
  if (seconds < 3600) return format.format(-Math.round(seconds / 60), 'minute');
  if (seconds < 86400) return format.format(-Math.round(seconds / 3600), 'hour');
  return format.format(-Math.round(seconds / 86400), 'day');
}
