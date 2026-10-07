/** The active run's workspace in the current layout mode. */
import { AnimatePresence, motion } from 'motion/react';
import { useLayout, useUi } from '../app/hooks';
import { useReducedMotionPref } from '../app/prefs';
import { FocusView } from './FocusView';
import { OverviewView } from './OverviewView';
import { PipelineView } from './PipelineView';
import { StripView } from './StripView';

export function Workspace({ runId }: { runId: string }) {
  const layout = useLayout(runId);
  const mode = useUi((s) => s.layoutMode);
  const reduced = useReducedMotionPref();
  if (!layout) return <WorkspaceSkeleton />;
  const view =
    mode === 'focus' ? (
      <FocusView layout={layout} />
    ) : mode === 'overview' ? (
      <OverviewView layout={layout} />
    ) : mode === 'pipeline' ? (
      <PipelineView layout={layout} />
    ) : (
      <StripView layout={layout} />
    );
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={`${runId}:${mode}`}
        data-workspace={runId}
        data-layout-mode={mode}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        initial={reduced ? false : { opacity: 0, scale: mode === 'overview' || mode === 'pipeline' ? 1.015 : 0.985 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, transition: { duration: 0.08 } }}
        transition={{ duration: reduced ? 0 : 0.15, ease: [0.16, 1, 0.3, 1] }}
      >
        {view}
      </motion.div>
    </AnimatePresence>
  );
}

export function WorkspaceSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 gap-[10px] p-[10px]" aria-busy="true">
      {[340, 44, 560, 480].map((w, i) => (
        <div
          key={w}
          className="placeholder h-full flex-none animate-pulse"
          style={{ width: w, animationDelay: `${i * 120}ms` }}
        />
      ))}
    </div>
  );
}
