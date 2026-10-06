import './theme/fonts';
import './theme/theme.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { builtinCommands, registerCommands } from './app/commands';
import { DemoClient, demoLive, isDemoMode } from './app/demo/client';
import { EngineProvider } from './app/engine';
import { EngineConnection } from './app/engine-connection';
import { uiStore } from './app/store';
import { connectStore, type EngineClient } from './app/sync';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

const demo = isDemoMode();
const client: EngineClient = demo ? new DemoClient({ live: demoLive() }) : new EngineConnection(window.legion);
uiStore.setState({ demo });
registerCommands(builtinCommands());
connectStore(client);

createRoot(root).render(
  <StrictMode>
    <EngineProvider connection={client}>
      <App />
    </EngineProvider>
  </StrictMode>,
);
