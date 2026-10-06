import './theme/fonts';
import './theme/theme.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { builtinCommands, registerCommands } from './app/commands';
import { demoLive, isDemoMode } from './app/demo-mode';
import { EngineProvider } from './app/engine';
import { EngineConnection } from './app/engine-connection';
import { applyAppearance } from './app/prefs';
import { uiStore } from './app/store';
import { connectStore, type EngineClient } from './app/sync';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

applyAppearance();

/** The fixture world (and the engine code it borrows for plan validation) only loads in demo mode. */
async function createClient(demo: boolean): Promise<EngineClient> {
  if (!demo) return new EngineConnection(window.legion);
  const { DemoClient } = await import('./app/demo/client');
  return new DemoClient({ live: demoLive() });
}

const demo = isDemoMode();
uiStore.setState({ demo });
registerCommands(builtinCommands());

void createClient(demo).then((client) => {
  connectStore(client);
  createRoot(root).render(
    <StrictMode>
      <EngineProvider connection={client}>
        <App />
      </EngineProvider>
    </StrictMode>,
  );
});
