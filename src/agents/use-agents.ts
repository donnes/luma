import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AGENT_ALERT_EVENT, canAlertOverApps, listenForAgentAlerts, watchAgents } from '../bridge';
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

/**
 * The alert to show now and `done` to move on: one for each request that
 * newly needs you while Luma is on screen, in turn. On Fire TV with
 * HomeGuard, the shell's own connection finds them, so it also alerts over
 * other apps. An alert leaves the queue once its request ends or the agents
 * page shows its agent.
 */
export function useAgentAlerts() {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<AgentAlert[]>([]);
  useEffect(() => {
    const connection = agentsConnection();
    let seen = loadSeen();
    let shell: Shell | undefined;
    let pairing: Pairing | null | undefined;
    // Requests this page's connection has seen pending, and the ones it has
    // seen end since. An alert from the shell can arrive before this
    // connection hears of its request, so only an ended request drops one.
    let pending = new Set<string>();
    const ended = new Set<string>();
    const wanted = (alert: AgentAlert) =>
      !ended.has(alert.requestId) &&
      // The agents page already shows the agent it follows.
      connection.getState().detail?.threadId !== alert.threadId;
    const enqueue = (alerts: AgentAlert[]) =>
      setQueue((queued) => {
        const next = [...queued, ...alerts].filter(wanted);
        // Unchanged, the queue keeps its identity and nothing renders.
        return next.length === queued.length && !alerts.length ? queued : next;
      });
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
      if (state.shell !== shell && state.shell.ready) {
        shell = state.shell;
        const now = pendingRequests(shell);
        for (const id of pending) if (!now.has(id)) ended.add(id);
        pending = now;
        // Recorded even when the shell alerts, so turning HomeGuard off later
        // doesn't announce what it already did.
        const taken = takeAlerts(shell, seen);
        if (taken.seen !== seen) saveSeen(taken.seen);
        seen = taken.seen;
        // This connection only runs while Luma is on screen. HomeGuard can be
        // turned on or off meanwhile, so who alerts is decided each time.
        if (taken.alerts.length && !document.hidden && !canAlertOverApps())
          alerts = taken.alerts.map((agent) => agentAlert(agent, t, state.pairing?.label ?? ''));
      }
      // Also runs when the agents page opens an agent, whose alerts then leave.
      enqueue(alerts);
    };
    const show = (event: Event) => {
      if (event instanceof CustomEvent) enqueue([event.detail]);
    };
    update();
    const unsubscribe = connection.subscribe(update);
    window.addEventListener(AGENT_ALERT_EVENT, show);
    listenForAgentAlerts();
    return () => {
      unsubscribe();
      window.removeEventListener(AGENT_ALERT_EVENT, show);
    };
  }, [t]);
  const done = useCallback(() => setQueue((queued) => queued.slice(1)), []);
  return { alert: queue[0], done };
}
