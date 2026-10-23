// Renders the inbox panel alone, without Luma's Launcher, the way an overlay
// window above other apps would. agents.spec.ts serves it on a bare page.
import { createRoot } from 'react-dom/client';
import { agentStatus, type Agent } from '../src/agents/model';
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

const log = (entry: string) =>
  document.body.setAttribute('data-log', `${document.body.dataset.log ?? ''}${entry};`);

createRoot(document.getElementById('root')!).render(
  <InboxPanel
    inbox={{
      needsYou: [
        agent('approve', {
          pendingRuntimeRequest: { id: 'r1', kind: 'command', createdAt: now },
        }),
      ],
      done: [agent('finished', {}), agent('failed', { status: 'failed' })],
      working: [],
    }}
    onOpen={(threadId) => log(`open ${threadId}`)}
    onClose={() => log('close')}
  />,
);
