// src/cli/errors.ts

// cac tags its own arg/option errors with name 'CACError' (not exported). Reuse
// that name so self-raised usage errors share the exit-2 path — no bespoke error type.
export const usageError = (message: string): Error =>
  Object.assign(new Error(message), { name: 'CACError' })
