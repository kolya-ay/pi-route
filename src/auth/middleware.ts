import type { MiddlewareHandler } from 'hono'

export const createAuthMiddleware =
  (authToken?: string): MiddlewareHandler =>
  async (c, next) => {
    if (!authToken) return next()

    const authHeader = c.req.header('Authorization')
    if (!authHeader) {
      return c.json({ error: 'Missing Authorization header' }, 401)
    }
    if (!authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'Malformed Authorization header — expected Bearer token' }, 401)
    }
    if (authHeader.slice('Bearer '.length) !== authToken) {
      return c.json({ error: 'Invalid API key' }, 401)
    }
    return next()
  }
