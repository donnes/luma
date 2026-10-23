// Renders the inbox panel alone, without Luma's Launcher, the way an overlay
// window above other apps would. agents.spec.ts serves it on a bare page.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { agentStatus, type Agent, type Inbox } from '../src/agents/model';
import type { ThreadShell } from '../src/agents/types';
import { InboxPanel } from '../src/components/agents/inbox';

const now = new Date().toISOString();
const agent = (id: string, patch: Partial<ThreadShell>): Agent => {
  const thread: ThreadShell = {
    id,
    projectId: 'p1',
    title: id,
    status: 'completed',
    activeRunId: null,
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    branch: null,
    settledOverride: null,
    settledAt: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    ...patch,
  };
  return { thread, project: undefined, status: agentStatus(thread) };
};

// `?tall` adds a needs-you group taller than the list, for scrolling.
const extra = location.search.includes('tall')
  ? Array.from({ length: 20 }, (_, i) =>
      agent(`ask${i}`, { pendingRuntimeRequest: { id: `q${i}`, kind: 'command', createdAt: now } }),
    )
  : [];

const log = (entry: string) =>
  document.body.setAttribute('data-log', `${document.body.dataset.log ?? ''}${entry};`);

const inbox: Inbox = {
  needsYou: [
    ...extra,
    agent('approve', {
      pendingRuntimeRequest: { id: 'r1', kind: 'command', createdAt: now },
    }),
  ],
  done: [agent('finished', {}), agent('failed', { status: 'failed' })],
  working: [],
};

// `?late` starts on a notice, as while connecting, and the rows follow.
function Standalone() {
  const late = location.search.includes('late');
  const [ready, setReady] = useState(!late);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 300);
    return () => clearTimeout(timer);
  }, []);
  return (
    <InboxPanel
      inbox={ready ? inbox : { needsYou: [], done: [], working: [] }}
      notice={ready ? undefined : { title: 'Connecting…' }}
      onOpen={(threadId) => log(`open ${threadId}`)}
      onClose={() => log('close')}
    />
  );
}

createRoot(document.getElementById('root')!).render(<Standalone />);
