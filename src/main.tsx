import { createRoot } from 'react-dom/client';
import { App } from './app';
import { registerRemoteKeys } from './bridge';
import './styles.css';
import './weather.css';
import './settings.css';
import './agents.css';

registerRemoteKeys();
createRoot(document.getElementById('root')!).render(<App />);
