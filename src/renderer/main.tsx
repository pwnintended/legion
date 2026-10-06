import './theme/fonts';
import './theme/theme.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { EngineProvider } from './app/engine';
import { EngineConnection } from './app/engine-connection';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

const connection = new EngineConnection(window.legion);

createRoot(root).render(
  <StrictMode>
    <EngineProvider connection={connection}>
      <App />
    </EngineProvider>
  </StrictMode>,
);
