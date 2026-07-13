import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createAuthMiddleware } from './middleware'

const appWith = (token?: string) => {
  const app = new Hono()
  app.use('*', createAuthMiddleware(token))
  app.get('/', (c) => c.text('ok'))
  return app
}

describe('createAuthMiddleware', () => {
  test('no token configured → open', async () => {
    const res = await appWith(undefined).request('/')
    expect(res.status).toBe(200)
  })
  test('matching bearer passes', async () => {
    const res = await appWith('sk-1').request('/', { headers: { Authorization: 'Bearer sk-1' } })
    expect(res.status).toBe(200)
  })
  test('missing header → 401', async () => {
    expect((await appWith('sk-1').request('/')).status).toBe(401)
  })
  test('wrong token → 401', async () => {
    const res = await appWith('sk-1').request('/', { headers: { Authorization: 'Bearer nope' } })
    expect(res.status).toBe(401)
  })
})
