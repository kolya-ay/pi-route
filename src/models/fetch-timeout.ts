// A hung endpoint (connection accepted, headers never sent) must not wedge a
// provider's refresh forever — pi-ai's Models.refresh() awaits every provider
// with Promise.all, so one stuck fetch blocks the catalog rebuild for every
// provider, and `inflight` never clears to let a later tick retry.
//
// Lives alone rather than in cached-catalog.ts because pipeline/metadata.ts
// needs it and cached-catalog.ts imports parseOpenaiModelsList from there —
// co-locating the constant with the wrapper would close that loop into a cycle.
export const FETCH_TIMEOUT_MS = 30_000
