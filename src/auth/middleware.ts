// src/auth/middleware.ts

import type { MiddlewareHandler } from 'hono'

export const createAuthMiddleware =
  (apiKeys: string[]): MiddlewareHandler =>
  async (c, next) => {
    if (apiKeys.length === 0) {
      return next()
    }

    const authHeader = c.req.header('Authorization')
    if (!authHeader) {
      return c.json({ error: 'Missing Authorization header' }, 401)
    }

    if (!authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'Malformed Authorization header — expected Bearer token' }, 401)
    }

    const token = authHeader.slice('Bearer '.length)
    if (!apiKeys.includes(token)) {
      return c.json({ error: 'Invalid API key' }, 401)
    }

    return next()
  }
