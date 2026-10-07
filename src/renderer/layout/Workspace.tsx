/**
 * A tiling workspace on screen: the project's Code view (`project:<id>`), a strip of columns. A run's own
 * layout tree is not drawn as a strip: the route map (agents/RouteMap.tsx) shows its focused tile.
 */
import { motion } from 'motion/react';
import { useLayout } from '../app/hooks';
import { useReducedMotionPref } from '../app/prefs';
import { StripView } from './StripView';

export function Workspace({ workspaceKey }: { workspaceKey: string }) {
  const layout = useLayout(workspaceKey);
  const reduced = useReducedMotionPref();
  if (!layout) return <WorkspaceSkeleton />;
  return (
    <motion.div
      data-workspace={workspaceKey}
      data-layout-mode="strip"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      initial={reduced ? false : { opacity: 0, scale: 0.985 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: reduced ? 0 : 0.15, ease: [0.16, 1, 0.3, 1] }}
    >
      <StripView layout={layout} />
    </motion.div>
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
