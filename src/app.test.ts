import { describe, expect, it } from 'vitest'

import { app } from './app'

describe('GET /', () => {
  it('responds with hello', async () => {
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello')
  })
})
