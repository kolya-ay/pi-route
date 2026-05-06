// src/backends/pi-ai/backend.test.ts

import { describe, expect, it } from 'bun:test'

import type { Account, IncomingRequest } from '../../types'

import { createPiAiBackend, getModel, registerModel } from './backend'

const makeRequest = (overrides?: Partial<IncomingRequest>): IncomingRequest => ({
  id: 'req-1',
  format: 'anthropic',
  rawRequest: new Request('http://localhost/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] })
  }),
  model: 'test-model',
  stream: false,
  ...overrides
})

const makeAccount = (overrides?: Partial<Account>): Account => ({
  type: 'api-key',
  name: 'test-account',
  resolveKey: () => 'sk-test-key',
  ...overrides
})

describe('createPiAiBackend', () => {
  it('returns a backend with correct name and type', () => {
    const backend = createPiAiBackend('my-backend', 'anthropic')
    expect(backend.name).toBe('my-backend')
    expect(backend.type).toBe('pi-ai')
  })

  it('throws when account has no resolveKey', async () => {
    const backend = createPiAiBackend('test', 'anthropic')
    const account = makeAccount({ resolveKey: undefined })
    const request = makeRequest()

    await expect(backend.dispatch(request, account)).rejects.toThrow(
      "Account 'test-account' has no resolveKey"
    )
  })

  it('throws when model is not found in registry', async () => {
    const backend = createPiAiBackend('test', 'anthropic')
    const account = makeAccount()
    const request = makeRequest({ model: 'nonexistent-model' })

    await expect(backend.dispatch(request, account)).rejects.toThrow(
      "Model 'nonexistent-model' not found in pi-ai registry"
    )
  })
})

describe('model registry', () => {
  it('registerModel stores and getModel retrieves', () => {
    const model = { id: 'registry-test-model' } as Parameters<typeof registerModel>[0]
    registerModel(model)
    expect(getModel('registry-test-model')).toBe(model)
  })

  it('getModel returns undefined for unknown model', () => {
    expect(getModel('unknown-model-xyz')).toBeUndefined()
  })
})
