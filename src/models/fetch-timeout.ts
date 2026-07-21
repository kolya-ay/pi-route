// A hung endpoint (connection accepted, headers never sent) must not wedge a
// provider's refresh forever — pi-ai's Models.refresh() awaits every provider
// with Promise.all, so one stuck fetch blocks the catalog rebuild for every
// provider, and `inflight` never clears to let a later tick retry.
//
// Lives alone rather than in cached-catalog.ts because pipeline/metadata.ts
// needs it and cached-catalog.ts imports parseOpenaiModelsList from there —
// co-locating the constant with the wrapper would close that loop into a cycle.
export const FETCH_TIMEOUT_MS = 30_000

// A narrower fetch than `typeof fetch`: Bun's mocks and bare
// `async () => Response` are assignable without the `preconnect` prop.
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

// The deadline, composed with whatever the caller already wanted cancelled.
export const deadline = (ms: number, signal?: AbortSignal): AbortSignal => {
  const timeout = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

// Bound a fetch once, at the seam, instead of threading a number down every
// call chain. The deadline is minted inside the returned closure, so each
// invocation gets its own full budget — which is what per-host fallback and
// repeated LRO polling depend on. Hoisting it out of the closure would share
// one budget across every attempt and starve the later ones.
export const deadlined =
  (fetchFn: FetchFn, ms = FETCH_TIMEOUT_MS): FetchFn =>
  (url, init) =>
    fetchFn(url, { ...init, signal: deadline(ms, init?.signal ?? undefined) })
