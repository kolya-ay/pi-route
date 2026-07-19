import type { MutableModels } from '@earendil-works/pi-ai'
import type { RuntimeState } from './config/state'
import type { Catalog } from './pipeline/catalog'
import type { RouterOptions } from './types'

export type RouterState = {
  options: RouterOptions
  catalog: Catalog
  models: MutableModels
  runtime: RuntimeState
  authDir: string
}

export const createState = (
  options: RouterOptions,
  catalog: Catalog,
  models: MutableModels,
  runtime: RuntimeState,
  authDir: string
): RouterState => ({
  options,
  catalog,
  models,
  runtime,
  authDir
})
