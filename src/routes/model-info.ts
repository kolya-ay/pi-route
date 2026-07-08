import type { Catalog } from '../pipeline/catalog'
import type { RouterOptions } from '../types'
import {
  exposedAddresses,
  type LiteLLMEntry,
  resolveModel,
  toLiteLLMInfo
} from './model-projection'

// LiteLLM proxy shape consumed by OMP `discovery: litellm`. Served identically at
// /model/info, /v1/model/info, /v2/model/info, /model_group/info.
export const buildModelInfoBody = (
  options: RouterOptions,
  catalog: Catalog
): { data: LiteLLMEntry[] } => {
  const data = exposedAddresses(options, catalog)
    .map((addr) => toLiteLLMInfo(resolveModel(options, catalog, addr)))
    .filter((e): e is LiteLLMEntry => e !== null)
  return { data }
}
