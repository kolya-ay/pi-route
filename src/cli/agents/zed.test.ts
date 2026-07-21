// src/cli/agents/zed.test.ts

import { expect, test } from 'bun:test'
import type { RoleModel } from '../agent'
import { zed } from './zed'

const model = (overrides: Partial<RoleModel> = {}): RoleModel => ({
  id: 'nvidia/some-model',
  name: 'Some Model',
  ...overrides
})

test('a fast model with maxTokens: 0 (endpoint said nothing) falls back to 64, not 0', async () => {
  const writes = await zed.write({
    url: 'http://localhost:1234',
    home: '/nonexistent-pi-route-test-home',
    all: [model()],
    main: model(),
    fast: model({ maxTokens: 0 })
  })
  const settings = JSON.parse(writes[0]?.content ?? '{}')
  expect(settings.edit_predictions.open_ai_compatible_api.max_output_tokens).toBe(64)
})
