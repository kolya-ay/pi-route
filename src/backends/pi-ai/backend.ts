// src/backends/pi-ai/backend.ts

import type { Backend } from '../../types.js'

export const createPiAiBackend = (name: string, _provider: string): Backend => ({
  name,
  type: 'pi-ai',

  async dispatch(): Promise<never> {
    throw new Error('not yet fully implemented')
  },
})
