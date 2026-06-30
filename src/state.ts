import type { RuntimeState } from './config/state'
import type { Catalog } from './pipeline/catalog'
import type { CredentialFile, RouterOptions } from './types'

export type RouterState = {
  options: RouterOptions
  catalog: Catalog
  runtime: RuntimeState
  credentials: Map<string, CredentialFile>
  timers: Map<string, ReturnType<typeof setTimeout>>
  refreshFailures: Map<string, number>
  authDir: string
}

export const createState = (
  options: RouterOptions,
  catalog: Catalog,
  runtime: RuntimeState,
  authDir: string
): RouterState => ({
  options,
  catalog,
  runtime,
  authDir,
  credentials: new Map(),
  timers: new Map(),
  refreshFailures: new Map()
})
