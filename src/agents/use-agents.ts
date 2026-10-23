import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { AGENT_ALERT_EVENT, canAlertOverApps, watchAgents } from '../bridge';
import { useTranslation } from '../i18n';
import {
  agentAlert,
  alertHeadline,
  loadSeen,
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
 * Calls `onAlert` once for each request that newly needs you while Luma is on
 * screen; `onAlert` should keep its identity. On Fire TV with HomeGuard, the
 * shell's own connection finds them, so it also alerts over other apps.
 */
export function useAgentAlerts(onAlert: (alert: AgentAlert) => void) {
  const { t } = useTranslation();
  useEffect(() => {
    const connection = agentsConnection();
    const fromShell = canAlertOverApps();
    let seen = loadSeen();
    let shell: Shell | undefined;
    let pairing: Pairing | null | undefined;
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
      if (state.shell === shell || !state.shell.ready) return;
      shell = state.shell;
      // Recorded even when the shell alerts, so turning HomeGuard off later
      // doesn't announce what it already did.
      const taken = takeAlerts(shell, seen);
      if (taken.seen !== seen) saveSeen(taken.seen);
      seen = taken.seen;
      // This connection only runs while Luma is on screen.
      if (!fromShell && !document.hidden)
        for (const agent of taken.alerts) onAlert(agentAlert(agent, t, state.pairing?.label ?? ''));
    };
    const show = (event: Event) => {
      if (event instanceof CustomEvent) onAlert(event.detail);
    };
    update();
    const unsubscribe = connection.subscribe(update);
    if (fromShell) window.addEventListener(AGENT_ALERT_EVENT, show);
    return () => {
      unsubscribe();
      window.removeEventListener(AGENT_ALERT_EVENT, show);
    };
  }, [onAlert, t]);
}
