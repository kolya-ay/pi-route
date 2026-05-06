import { getOAuthApiKey } from '@mariozechner/pi-ai/oauth'

import type { Account } from './types'
import { interpolateEnvVars } from './config/loader'
import { parseConfig } from './config/schema'

const configPath = Bun.env.ROUTER_CONFIG ?? 'router.json'
const file = Bun.file(configPath)
const raw: unknown = await file.json()
const interpolated = interpolateEnvVars(raw)
const options = parseConfig(interpolated)

const wireResolveKey = (account: Account): void => {
  const extra = account as unknown as Record<string, unknown>
  if (account.type === 'api-key' && typeof extra['key'] === 'string') {
    const key = extra['key'] as string
    Object.assign(account, { resolveKey: () => key })
  } else if (account.type === 'claude-cli' && typeof extra['tokenPath'] === 'string') {
    const tokenPath = extra['tokenPath'] as string
    Object.assign(account, {
      resolveKey: async () => {
        const creds = Bun.file(tokenPath)
        const parsed = JSON.parse(await creds.text()) as { oauthToken: string }
        return parsed.oauthToken
      }
    })
  } else if (account.type === 'antigravity-oauth' && typeof extra['refreshToken'] === 'string') {
    const refreshToken = extra['refreshToken'] as string
    const projectId = (extra['projectId'] as string) ?? ''
    Object.assign(account, {
      resolveKey: async () => {
        const result = await getOAuthApiKey('google-antigravity', {
          'google-antigravity': { refresh: refreshToken, access: '', expires: 0, projectId }
        })
        if (!result) throw new Error(`Failed to get API key for account '${account.name}'`)
        return result.apiKey
      }
    })
  }
}

for (const backend of Object.values(options.backends)) {
  backend.accounts.forEach(wireResolveKey)
}

const { createApp } = await import('./app')
const app = createApp(options)

console.log(`Router listening on http://${options.server.host}:${options.server.port}`)

export default { port: options.server.port, hostname: options.server.host, fetch: app.fetch }
