/**
 * App shell: title bar, rail, then what is in view: the project's board of conversations (chat view; the active
 * run is its focused tile), the active run's route map of agents (agents view), or the project's code strip
 * (code view, and a project with no run); onboarding when there is nothing yet. Status bar, overlays.
 * Overlays (composer, inbox, palette) are rendered by `overlays/index.tsx` (default export, mounted once here)
 * and read `uiStore.overlay` to decide what to show.
 */
import { MotionConfig } from 'motion/react';
import { type ComponentType, lazy, Suspense, useEffect } from 'react';
import { RouteMap } from '../agents/RouteMap';
import { Board } from '../board/Board';
import { boardKeyOf } from '../board/state';
import { Onboarding } from '../chrome/Onboarding';
import { Rail } from '../chrome/Rail';
import { StatusBar } from '../chrome/StatusBar';
import { TitleBar } from '../chrome/TitleBar';
import { Workspace, WorkspaceSkeleton } from '../layout/Workspace';
import { installKeybindings } from './commands';
import { useConnection, useData, useRuns, useUi } from './hooks';
import { useMotionConfig } from './prefs';
import { activeWorkspaceKey } from './store';

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
  const hasProjects = useData((s) => Object.keys(s.projects).length > 0);
  const workspaceKey = useUi(activeWorkspaceKey);
  const activeRunId = useUi((s) => s.activeRunId);
  const activeProjectId = useUi((s) => s.activeProjectId);
  const view = useUi((s) => s.view);
  const boardKey = useData((s) => {
    const run = activeRunId ? s.runs[activeRunId] : undefined;
    return run ? boardKeyOf(s, run) : activeProjectId;
  });
  const reducedMotion = useMotionConfig();

  let content: React.ReactNode;
  if (!connection.loaded) content = <WorkspaceSkeleton />;
  else if (runs.length === 0 && !hasProjects) content = <Onboarding />;
  else if (view === 'chat' && boardKey) content = <Board key={boardKey} boardKey={boardKey} />;
  else if (view === 'agents' && activeRunId) content = <RouteMap key={activeRunId} runId={activeRunId} />;
  else if (workspaceKey) content = <Workspace key={workspaceKey} workspaceKey={workspaceKey} />;
  else content = <WorkspaceSkeleton />;

  return (
    <MotionConfig reducedMotion={reducedMotion}>
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
