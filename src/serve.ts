import { refreshAccessToken } from './auth/antigravity-oauth'
import { createOAuthResolveKey } from './auth/credentials'
import { interpolateEnvVars } from './config/loader'
import { parseConfig } from './config/schema'
import type { Account } from './types'

const configPath = Bun.env.ROUTER_CONFIG ?? 'router.json'
const file = Bun.file(configPath)
const raw: unknown = await file.json()
const interpolated = interpolateEnvVars(raw)
const options = parseConfig(interpolated)

const wireResolveKey = (account: Account): void => {
  const extra = account as unknown as Record<string, unknown>
  if (account.type === 'api-key' && typeof extra.key === 'string') {
    const key = extra.key as string
    Object.assign(account, { resolveKey: () => key })
  } else if (account.type === 'claude-cli' && typeof extra.tokenPath === 'string') {
    const tokenPath = extra.tokenPath as string
    Object.assign(account, {
      resolveKey: async () => {
        const creds = Bun.file(tokenPath)
        const parsed = JSON.parse(await creds.text()) as { oauthToken: string }
        return parsed.oauthToken
      }
    })
  } else if (account.type === 'antigravity-oauth') {
    Object.assign(account, {
      resolveKey: createOAuthResolveKey(options.authDir, account.name, async (refreshToken) => {
        const refreshed = await refreshAccessToken(refreshToken)
        return {
          provider: 'google-antigravity',
          refreshToken: refreshed.refresh,
          accessToken: refreshed.access,
          expires: refreshed.expires
        }
      })
    })
  }
}

for (const provider of Object.values(options.providers)) {
  provider.accounts.forEach(wireResolveKey)
}

const { createApp } = await import('./app')
const app = createApp(options)

console.log(`Router listening on http://${options.server.host}:${options.server.port}`)

export default { port: options.server.port, hostname: options.server.host, fetch: app.fetch }
