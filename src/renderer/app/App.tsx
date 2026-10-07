/**
 * App shell: title bar, rail, then what is in view: a run's conversation (chat view) or its agents' workspace
 * (agents view); a project's new-conversation page (chat) or its repository home (agents); onboarding when there
 * is nothing yet. Status bar, overlays.
 * Overlays (composer, inbox, palette) are rendered by `overlays/index.tsx` (default export, mounted once here)
 * and read `uiStore.overlay` to decide what to show.
 */
import { MotionConfig } from 'motion/react';
import { type ComponentType, lazy, Suspense, useEffect } from 'react';
import { ChatView } from '../chat/ChatView';
import { NewConversation } from '../chat/NewConversation';
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
  const reducedMotion = useMotionConfig();

  let content: React.ReactNode;
  if (!connection.loaded) content = <WorkspaceSkeleton />;
  else if (runs.length === 0 && !hasProjects) content = <Onboarding />;
  else if (view === 'chat' && activeRunId) content = <ChatView key={activeRunId} runId={activeRunId} />;
  else if (view === 'chat' && activeProjectId)
    content = <NewConversation key={activeProjectId} projectId={activeProjectId} />;
  else if (workspaceKey) content = <Workspace key={workspaceKey} runId={workspaceKey} />;
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
