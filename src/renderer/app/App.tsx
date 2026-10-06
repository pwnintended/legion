/**
 * App shell: title bar, rail, the active run's workspace (or onboarding), status bar, overlays.
 * Overlays (composer, inbox, palette) are rendered by `overlays/index.tsx` (default export, mounted once here)
 * and read `uiStore.overlay` to decide what to show.
 */
import { MotionConfig } from 'motion/react';
import { type ComponentType, lazy, Suspense, useEffect } from 'react';
import { Onboarding } from '../chrome/Onboarding';
import { Rail } from '../chrome/Rail';
import { StatusBar } from '../chrome/StatusBar';
import { TitleBar } from '../chrome/TitleBar';
import { Workspace, WorkspaceSkeleton } from '../layout/Workspace';
import { installKeybindings } from './commands';
import { useActiveRunId, useConnection, useRuns, useUi } from './hooks';

const overlayModules = import.meta.glob<{ default: ComponentType }>('../overlays/index.tsx');
const overlayLoader = Object.values(overlayModules)[0];
const Overlays = overlayLoader ? lazy(overlayLoader) : null;

export function App() {
  useEffect(() => installKeybindings(), []);
  // Mirror overlay state on <body> (CSS hooks, tests).
  const overlay = useUi((s) => s.overlay);
  useEffect(() => {
    if (overlay) document.body.dataset.overlay = overlay;
    else delete document.body.dataset.overlay;
  }, [overlay]);
  const runs = useRuns();
  const connection = useConnection();
  const activeRunId = useActiveRunId();

  let content: React.ReactNode;
  if (!connection.loaded) content = <WorkspaceSkeleton />;
  else if (runs.length === 0) content = <Onboarding />;
  else if (activeRunId) content = <Workspace key={activeRunId} runId={activeRunId} />;
  else content = <WorkspaceSkeleton />;

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex h-full flex-col bg-crust" data-testid="app">
        <TitleBar />
        <div className="flex min-h-0 flex-1">
          <Rail />
          <main className="relative flex min-w-0 flex-1 flex-col" aria-label="Workspace">
            {content}
          </main>
        </div>
        <StatusBar />
        {Overlays ? (
          <Suspense fallback={null}>
            <Overlays />
          </Suspense>
        ) : null}
      </div>
    </MotionConfig>
  );
}
