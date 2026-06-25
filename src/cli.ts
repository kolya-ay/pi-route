#!/usr/bin/env bun
// src/cli.ts

import { getOAuthProvider, type OAuthCredentials } from '@mariozechner/pi-ai/oauth'

import { writeCredentials } from './auth/credentials'
import { deriveName } from './auth/name-derivers'
import { registerAllOAuthProviders } from './auth/register-all-oauth'
import { readEnvConfig } from './config/env'
import type { CredentialFile } from './types'

const usage = `Usage:
  pi-route login <provider-type> [name]
  pi-route serve

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
} else {
  console.error(usage)
  process.exit(1)
}
