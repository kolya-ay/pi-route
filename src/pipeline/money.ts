// src/pipeline/money.ts
//
// Per-token USD, tagged so a per-MILLION rate (the catalog convention for
// Model.cost) cannot be silently used where a per-token rate is required. That
// mix once reported cost 1e6x too high (4e7c8c2). The consumer boundary
// (StreamMetricsCtx.costs) requires PerTokenUsd, so a dropped conversion is a
// compile error. The tag is phantom: it erases to `number` at runtime.
export type PerTokenUsd = number & { readonly __unit: 'usd/token' }

// The only constructor of PerTokenUsd: scale a per-MILLION rate down by 1e-6.
// Multiplying by 1e-6 (not dividing by 1_000_000) lands 0.1/M on 1e-7 exactly
// under IEEE754 — the mirror of metadata.ts's divide-by-1e-6 up-conversion.
export const perTokenUsd = (rate: number): PerTokenUsd => (rate * 1e-6) as PerTokenUsd
