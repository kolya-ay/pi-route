// src/telemetry/hono-env.ts
// Tel is a forward-reference to ./tel (created in Task 5).

import { createFactory } from 'hono/factory'

import type { RouterState } from '../state'

import type { Tel } from './tel'

export type Env = {
  Variables: {
    requestId: string
    tel: Tel
    state: RouterState
  }
}

export const factory = createFactory<Env>()
