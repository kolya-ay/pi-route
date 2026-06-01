import type { CredentialFile, RouterOptions, TelemetryEmitter } from './types'

export type RouterState = {
  options: RouterOptions
  credentials: Map<string, CredentialFile>
  timers: Map<string, ReturnType<typeof setTimeout>>
  refreshFailures: Map<string, number>
  persist: ((opts: RouterOptions) => Promise<void>) | null
  telemetry: TelemetryEmitter
}

export const createState = (
  options: RouterOptions,
  persist: ((opts: RouterOptions) => Promise<void>) | null,
  telemetry: TelemetryEmitter
): RouterState => ({
  options,
  credentials: new Map(),
  timers: new Map(),
  refreshFailures: new Map(),
  persist,
  telemetry
})
