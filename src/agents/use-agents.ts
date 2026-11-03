import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  AGENT_ALERT_EVENT,
  AGENT_ALERTS_ENDED_EVENT,
  canAlertOverApps,
  listenForAgentAlerts,
  watchAgents,
} from '../bridge';
import { useTranslation } from '../i18n';
import {
  agentAlert,
  alertHeadline,
  loadSeen,
  pendingRequests,
  saveSeen,
  takeAlerts,
  type AgentAlert,
} from './alerts';
import { agentsConnection } from './connection';
import type { Pairing } from './pairing';
import { inboxGroups, isWorking, shelfAgents, type Shell } from './model';

export const AGENTS_APP_ID = 'luma.agents';

export function useAgents() {
  const connection = agentsConnection();
  const state = useSyncExternalStore(connection.subscribe, connection.getState);
  const agents = useMemo(() => shelfAgents(state.shell), [state.shell]);
  const inbox = useMemo(() => inboxGroups(state.shell), [state.shell]);
  // The shelf stops at a dozen cards; every request still counts.
  const waiting = inbox.needsYou.length;
  const working = agents.filter((agent) => isWorking(agent.status)).length;
  return { connection, state, agents, inbox, waiting, working };
}

/** Holds the connection open while Luma is on screen and drops it when another app is. */
export function useAgentsLifecycle() {
  useEffect(() => {
    const connection = agentsConnection();
    const sync = () => (document.hidden ? connection.pause() : connection.resume());
    sync();
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('webOSRelaunch', sync);
    window.addEventListener('online', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('webOSRelaunch', sync);
      window.removeEventListener('online', sync);
    };
  }, []);
}

// Keys queue entries apart, so each alert's toast starts over.
let entries = 0;

/**
 * The alert to show now, with a key of its own, and `done` to move on: one
 * for each request that newly needs you while Luma is on screen, in turn. On
 * Fire TV with HomeGuard, the shell's own connection decides alone what's new
 * and what ended, so it also alerts over other apps; the page shows what the
 * shell sends it. An alert leaves the queue once its request ends or the
 * agents page shows its agent.
 */
export function useAgentAlerts() {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<{ key: number; alert: AgentAlert }[]>([]);
  useEffect(() => {
    const connection = agentsConnection();
    let shell: Shell | undefined;
    let pairing: Pairing | null | undefined;
    // Requests pending in the last shell this page saw. One that was and no
    // longer is has ended, whoever alerted it; one the page hasn't seen yet,
    // like an alert HomeGuard forwarded ahead of the page's stream, stays.
    let pending = new Set<string>();
    // The history while this page finds alerts itself; undefined while
    // HomeGuard does and keeps it.
    const sync = (alerts: AgentAlert[], ended: Iterable<string> = []) => {
      const gone = new Set(ended);
      setQueue((queued) => {
        // The agents page already shows the agent it follows.
        const shown = connection.getState().detail?.threadId;
        const next = queued.filter(
          ({ alert }) => !gone.has(alert.requestId) && alert.threadId !== shown,
        );
        // One entry per request, even if the shell sends it twice.
        const requests = new Set(next.map(({ alert }) => alert.requestId));
        let added = false;
        for (const alert of alerts) {
          if (requests.has(alert.requestId) || alert.threadId === shown) continue;
          requests.add(alert.requestId);
          next.push({ key: ++entries, alert });
          added = true;
        }
        // Unchanged, the queue keeps its identity and nothing renders.
        return added || next.length < queued.length ? next : queued;
      });
    };
    const update = () => {
      const state = connection.getState();
      // Handed over even while HomeGuard is off: the shell keeps it for when
      // HomeGuard comes on, and an old pairing must not outlive an unpair.
      if (state.pairing !== pairing) {
        pairing = state.pairing;
        watchAgents(
          pairing && {
            environmentId: pairing.environmentId,
            routes: pairing.routes.map((route) => route.url),
            token: pairing.token,
            source: pairing.label,
            asked: alertHeadline(t, 'input'),
            approval: alertHeadline(t, 'approval'),
          },
        );
      }
      let alerts: AgentAlert[] = [];
      let ended: string[] = [];
      if (state.shell !== shell && state.shell.ready) {
        shell = state.shell;
        const was = pending;
        pending = pendingRequests(state.shell);
        ended = [...was].filter((id) => !pending.has(id));
        // HomeGuard can be turned on or off while the page lives on, so who
        // alerts is decided each time.
        let before: string[] | null | undefined;
        if (!canAlertOverApps()) {
          // Read every time: HomeGuard may have kept the history since the
          // last update. Toggling HomeGuard can still repeat one alert while
          // the page lags behind its stream, which is rare enough to accept.
          try {
            before = loadSeen();
          } catch {
            // Unreadable for now: the next update tries again.
            shell = undefined;
          }
        }
        if (before !== undefined) {
          const taken = takeAlerts(state.shell, before);
          if (taken.seen !== before) saveSeen(taken.seen);
          // This connection only runs while Luma is on screen.
          if (!document.hidden)
            alerts = taken.alerts.map((agent) => agentAlert(agent, t, state.pairing?.label ?? ''));
        }
      }
      // Also runs when the agents page opens an agent, whose alerts then leave.
      sync(alerts, ended);
    };
    const show = (event: Event) => {
      if (event instanceof CustomEvent) sync([event.detail]);
    };
    const end = (event: Event) => {
      if (event instanceof CustomEvent) sync([], event.detail);
    };
    update();
    const unsubscribe = connection.subscribe(update);
    window.addEventListener(AGENT_ALERT_EVENT, show);
    window.addEventListener(AGENT_ALERTS_ENDED_EVENT, end);
    listenForAgentAlerts();
    return () => {
      unsubscribe();
      window.removeEventListener(AGENT_ALERT_EVENT, show);
      window.removeEventListener(AGENT_ALERTS_ENDED_EVENT, end);
    };
  }, [t]);
  const done = useCallback(() => setQueue((queued) => queued.slice(1)), []);
  return { toast: queue[0], done };
}
