import type { RuntimeState } from './config/state'
import type { Catalog } from './pipeline/catalog'
import type { CredentialFile, RouterOptions, TelemetryEmitter } from './types'

export type RouterState = {
  options: RouterOptions
  catalog: Catalog
  runtime: RuntimeState
  credentials: Map<string, CredentialFile>
  timers: Map<string, ReturnType<typeof setTimeout>>
  refreshFailures: Map<string, number>
  authDir: string
  telemetry: TelemetryEmitter
}

export const createState = (
  options: RouterOptions,
  catalog: Catalog,
  runtime: RuntimeState,
  authDir: string,
  telemetry: TelemetryEmitter
): RouterState => ({
  options,
  catalog,
  runtime,
  authDir,
  credentials: new Map(),
  timers: new Map(),
  refreshFailures: new Map(),
  telemetry
})
