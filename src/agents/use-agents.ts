import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { agentsConnection } from './connection';
import { needsYou, isWorking, shelfAgents } from './model';

export const AGENTS_APP_ID = 'luma.agents';

export function useAgents() {
  const connection = agentsConnection();
  const state = useSyncExternalStore(connection.subscribe, connection.getState);
  const agents = useMemo(() => shelfAgents(state.shell), [state.shell]);
  const waiting = agents.filter((agent) => needsYou(agent.status)).length;
  const working = agents.filter((agent) => isWorking(agent.status)).length;
  return { connection, state, agents, waiting, working };
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
