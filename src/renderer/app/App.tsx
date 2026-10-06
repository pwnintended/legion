import type { AppInfo } from '@shared/rpc';
import { useConnectionState, useRpcQuery } from './engine';

/** Placeholder shell: proves the renderer ↔ engine round trip. Replaced by chrome/ + layout/. */
export function App() {
  const { status, generation } = useConnectionState();
  // Refetch whenever a new engine port arrives (e.g. the engine restarted after a crash).
  const info = useRpcQuery('app.info', {}, generation);

  return (
    <div className="flex h-full flex-col">
      <header className="drag flex h-10 shrink-0 items-center gap-3 border-b border-surface0 bg-mantle pl-20 pr-4">
        <span className="text-sm font-semibold tracking-tight text-text">Legion</span>
        <StatusDot status={status} />
      </header>
      <main className="flex flex-1 items-center justify-center bg-crust p-8">
        {info.status === 'success' ? (
          <EngineInfo info={info.data} />
        ) : info.status === 'error' ? (
          <p className="font-mono text-sm text-error">{info.error.message}</p>
        ) : (
          <p className="font-mono text-sm text-overlay1">connecting to engine…</p>
        )}
      </main>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color = status === 'connected' ? 'bg-ok' : status === 'connecting' ? 'bg-attention' : 'bg-error';
  return (
    <span className="flex items-center gap-1.5 text-xs text-subtext0" data-testid="connection-status">
      <span className={`size-1.5 rounded-full ${color}`} />
      {status}
    </span>
  );
}

function EngineInfo({ info }: { info: AppInfo }) {
  const rows: [string, string][] = [
    ['version', info.version],
    ['runtime', `node ${info.runtime.node}${info.runtime.electron ? ` · electron ${info.runtime.electron}` : ''}`],
    ['platform', `${info.runtime.platform} ${info.runtime.arch}`],
    ['engine pid', String(info.pid)],
    ['database', info.dbPath],
    ['schema', `v${info.schemaVersion} · head seq ${info.headSeq}`],
  ];
  return (
    <section
      data-testid="engine-info"
      className="w-full max-w-xl rounded-xl border border-surface0 bg-base p-5 shadow-lg shadow-crust/50"
    >
      <h1 className="mb-4 flex items-center gap-2 text-sm font-medium text-subtext1">
        <span className="size-2 rounded-full bg-ok" /> engine ready
      </h1>
      <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2 font-mono text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-overlay1">{label}</dt>
            <dd className="truncate text-text" title={value} data-testid={`info-${label.replace(' ', '-')}`}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
