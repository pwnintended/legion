/** What the main area shows while the engine connection loads: the tall layout's shape, quietly breathing. */
export function WorkspaceSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 gap-[10px] p-[10px]" aria-busy="true">
      <div className="placeholder h-full flex-[56] animate-pulse" />
      <div className="flex h-full flex-[44] flex-col gap-[10px]">
        {[0, 1].map((i) => (
          <div key={i} className="placeholder flex-1 animate-pulse" style={{ animationDelay: `${(i + 1) * 120}ms` }} />
        ))}
      </div>
    </div>
  );
}
