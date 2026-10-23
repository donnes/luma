import { useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { useAgentsLifecycle } from './agents/use-agents';
import { AgentsInbox } from './components/agents/inbox';
import { LanguageProvider } from './i18n';
import { loadPreferences } from './storage';

/**
 * The agents inbox alone, over a transparent page: what the Fire TV shell's
 * InboxActivity shows above another app when Menu is pressed there. The shell
 * closes that window itself, on Back and Menu before the page sees them and
 * once T3 Code comes to the front after OK, so nothing here closes it. Threads
 * always open in T3 Code's web app, which that shell hosts.
 */
export function InboxApp() {
  const [preferences] = useState(loadPreferences);
  const [error, setError] = useState('');
  useAgentsLifecycle();
  return (
    <LanguageProvider language={preferences.language}>
      <div className={preferences.reducedMotion ? 'reduce-motion' : undefined}>
        <AgentsInbox onClose={() => {}} onConversation={() => {}} notify={setError} />
        {error ? (
          <div className="toast toast-error" role="alert">
            <CircleAlert size={20} />
            <span>{error}</span>
          </div>
        ) : null}
      </div>
    </LanguageProvider>
  );
}
