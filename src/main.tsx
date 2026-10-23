import { createRoot } from 'react-dom/client';
import { App } from './app';
import { registerRemoteKeys } from './bridge';
import { InboxApp } from './inbox-app';
import './styles.css';
import './weather.css';
import './settings.css';
import './agents.css';

registerRemoteKeys();
// The Fire TV shell loads #inbox in its window over other apps.
const inboxOnly = location.hash === '#inbox';
document.documentElement.classList.toggle('inbox-only', inboxOnly);
createRoot(document.getElementById('root')!).render(inboxOnly ? <InboxApp /> : <App />);
