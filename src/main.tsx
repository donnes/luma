import { createRoot } from 'react-dom/client';
import { App } from './app';
import './styles.css';
import './weather.css';
import './settings.css';
import './agents.css';

createRoot(document.getElementById('root')!).render(<App />);
