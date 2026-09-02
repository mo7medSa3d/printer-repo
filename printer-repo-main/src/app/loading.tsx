/**
 * Branded route-level loading state: the same card geometry and shimmer the
 * console uses everywhere, so navigation never flashes an unstyled screen.
 */
export default function Loading() {
  return (
    <div className="container mx-auto px-4 py-8" role="status" aria-label="Loading">
      <div className="skeleton h-7 w-56" />
      <div className="skeleton mt-3 h-4 w-full max-w-2xl" />
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="card p-5">
            <div className="skeleton h-4 w-32" />
            <div className="skeleton mt-2 h-3 w-44" />
            <div className="mt-5 space-y-3">
              <div className="skeleton h-9 w-full" />
              <div className="skeleton h-9 w-[88%]" />
              <div className="skeleton h-9 w-[76%]" />
            </div>
          </div>
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
