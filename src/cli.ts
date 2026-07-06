#!/usr/bin/env bun
// src/cli.ts

import { getOAuthProvider, type OAuthCredentials } from '@mariozechner/pi-ai/oauth'

import { writeCredentials } from './auth/credentials'
import { deriveName } from './auth/name-derivers'
import { registerAllOAuthProviders } from './auth/register-all-oauth'
import { formatTable, runStats } from './cli/stats'
import { readEnvConfig } from './config/env'
import { loadConfig } from './config/loader'
import { collectLimitsSnapshot } from './limits'
import { buildCatalog } from './pipeline/catalog'
import { createState } from './state'
import { createTel } from './telemetry/tel'
import type { CredentialFile } from './types'

const usage = `Usage:
  pi-route login <provider-type> [name]
  pi-route serve
  pi-route limits
  pi-route stats [--by provider|model|day|session] [--since 7d]

Known OAuth provider types: anthropic, openai-codex, google-antigravity`

const [, , verb, target, arg2] = Bun.argv

const tryOpen = (url: string): void => {
  for (const opener of ['xdg-open', 'open']) {
    try {
      Bun.spawn([opener, url]).exited.catch(() => {})
      return
    } catch {
      // try next opener
    }
  }
}

const log = (msg: string): void => {
  console.error(`… ${msg}`)
}

const onAuth = ({ url }: { url: string }): void => {
  console.error(`Open in browser: ${url}`)
  tryOpen(url)
}

const onPrompt = async (): Promise<string> => ''

if (verb === 'login') {
  if (!target) {
    console.error(usage)
    process.exit(1)
  }

  registerAllOAuthProviders()

  const provider = getOAuthProvider(target)
  if (!provider) {
    console.error(`Unknown OAuth provider: "${target}"`)
    console.error(usage)
    process.exit(1)
  }

  const env = readEnvConfig()
  const creds: OAuthCredentials = await provider.login({
    onAuth,
    onPrompt,
    onProgress: log
  })

  const name = arg2 ?? deriveName(target, creds)
  if (!name) {
    console.error(`Name required for provider "${target}": pi-route login ${target} <name>`)
    process.exit(1)
  }

  const credentialFile: CredentialFile = { ...creds, provider: target }
  await writeCredentials(env.authDir, name, credentialFile)
  console.log(`Logged in: ${target}/${name}`)
} else if (verb === 'serve') {
  await import('./serve')
} else if (verb === 'limits') {
  registerAllOAuthProviders()
  const env = readEnvConfig()
  const { options, state: runtime } = await loadConfig(env.configPath, env.authDir)
  const catalog = buildCatalog(options)
  const state = createState(options, catalog, runtime, env.authDir)
  const snapshot = await collectLimitsSnapshot(state, createTel())
  console.log(JSON.stringify(snapshot, null, 2))
} else if (verb === 'stats') {
  const argVal = (flag: string, def: string): string => {
    const idx = Bun.argv.indexOf(flag)
    if (idx === -1) return def
    const val = Bun.argv[idx + 1]
    if (val === undefined || val.startsWith('--')) {
      console.error(`Missing value for ${flag}`)
      process.exit(1)
    }
    return val
  }
  const byArg = argVal('--by', 'provider')
  const since = argVal('--since', '7d')
  if (!['provider', 'model', 'day', 'session'].includes(byArg)) {
    console.error(`Invalid --by "${byArg}". Must be one of: provider|model|day|session`)
    process.exit(1)
  }
  const by = byArg as 'provider' | 'model' | 'day' | 'session'
  const rows = await runStats({ by, since })
  console.log(formatTable(by, rows))
} else if (verb === 'query') {
  const viewer =
    process.env.PI_ROUTE_VIEWER_URL ??
    `http://localhost:${process.env.PI_ROUTE_VIEWER_PORT ?? '8000'}`
  console.error(
    [
      'pi-route query is deprecated.',
      '',
      `Open the viewer UI: ${viewer}`,
      'Or run ad-hoc SQL against the viewer database:',
      '  duckdb ~/.cache/pi-route/otel.duckdb'
    ].join('\n')
  )
  process.exit(2)
} else {
  console.error(usage)
  process.exit(1)
}
