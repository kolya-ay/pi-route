import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MutableModels } from '@earendil-works/pi-ai'
import type { RouterOptions } from '../types'
import { buildModels } from './build'

// A real Models over a throwaway dir, for tests. Static provider catalogs
// (cerebras, anthropic, …) resolve synchronously with no network, so tests get
// real addresses/metadata without a refresh.
export const buildTestModels = (options: RouterOptions): MutableModels => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-route-test-'))
  return buildModels(options, { stateDir: dir, authDir: dir })
}
