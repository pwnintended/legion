/** RPC procedures of the lifecycle service (`runs.*`, `tasks.*`, `inbox.*`, `sessions.*`, ...). */
import type { EngineRpcServer } from '../rpc/server';
import {
  approveMerge,
  cancelRun,
  pauseRun,
  requestChanges,
  resolveInbox,
  resumeRun,
  retryTask,
  setTaskEngine,
  skipTask,
} from './actions';
import { archiveRun, refreshPr } from './cleanup';
import { getDiff } from './diff';
import { createPr } from './finalize';
import type { Orchestrator } from './orchestrator';
import { answerClarify, approvePlan, createRun, requestPlanRevision, updatePlan } from './planner';
import { interruptSession, sendToSession, takeover } from './sessions';

export function registerOrchestratorHandlers(server: EngineRpcServer, o: Orchestrator): void {
  const { store } = o;

  server.implement('engines.list', () => o.registry.list());
  server.implement('engines.probe', ({ kind }) => o.registry.probe(kind));

  server.implement('runs.get', ({ runId }) => store.runSnapshot(runId));
  server.implement('runs.create', (input) => createRun(o, input));
  server.implement('runs.answerClarify', ({ runId, answers }) => answerClarify(o, runId, answers));
  server.implement('runs.updatePlan', (input) => updatePlan(o, input));
  server.implement('runs.approvePlan', ({ runId, planId }) => approvePlan(o, runId, planId));
  server.implement('runs.requestPlanRevision', ({ runId, planId, feedback }) =>
    requestPlanRevision(o, runId, planId, feedback),
  );
  server.implement('runs.pause', ({ runId }) => pauseRun(o, runId));
  server.implement('runs.resume', ({ runId }) => resumeRun(o, runId));
  server.implement('runs.cancel', ({ runId }) => cancelRun(o, runId));
  server.implement('runs.createPr', ({ runId, title, body }) => createPr(o, runId, title, body));
  server.implement('runs.refreshPr', ({ runId }) => refreshPr(o, runId));
  server.implement('runs.archive', ({ runId }) => archiveRun(o, runId));

  server.implement('tasks.retry', ({ taskId, note }) => retryTask(o, taskId, note));
  server.implement('tasks.skip', ({ taskId }) => skipTask(o, taskId));
  server.implement('tasks.setEngine', ({ taskId, engine, model, effort }) =>
    setTaskEngine(o, taskId, engine, model, effort),
  );
  server.implement('tasks.approveMerge', ({ taskId }) => approveMerge(o, taskId));
  server.implement('tasks.requestChanges', ({ taskId, feedback }) => requestChanges(o, taskId, feedback));

  server.implement('inbox.list', (filter) => store.listInbox(filter));
  server.implement('inbox.resolve', ({ itemId, resolution }) => resolveInbox(o, itemId, resolution));

  server.implement('sessions.send', async ({ attemptId, text, priority }) => {
    await sendToSession(o, attemptId, text, priority);
    return { ok: true };
  });
  server.implement('sessions.interrupt', async ({ attemptId }) => {
    await interruptSession(o, attemptId);
    return { ok: true };
  });
  server.implement('sessions.takeover', ({ attemptId, cols, rows }) => takeover(o, attemptId, cols, rows));

  server.implement('attempts.get', ({ attemptId }) => store.requireAttempt(attemptId));
  server.implement('attempts.transcript', ({ attemptId, sinceSeq, limit }) => {
    store.requireAttempt(attemptId);
    return store.attemptTranscript(attemptId, sinceSeq, limit);
  });

  server.implement('diff.get', ({ target, contextLines }) => getDiff(o, target, contextLines));
}
