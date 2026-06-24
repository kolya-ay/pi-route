#!/usr/bin/env bun
// src/cli.ts

import { loginAntigravity } from './auth/antigravity-oauth'
import { writeCredentials } from './auth/credentials'
import { discoverEmail, loginOpenAICodex } from './auth/openai-codex-oauth'
import { readEnvConfig } from './config/env'
import type { CredentialFile } from './types'

const usage = `Usage:
  pi-route login antigravity <email>
  pi-route login codex [email]
  pi-route serve`

const [, , verb, target, arg2] = Bun.argv

const tryOpen = (url: string): void => {
  for (const opener of ['xdg-open', 'open']) {
    try {
      Bun.spawn([opener, url]).exited.catch(() => {})
      return
    } catch {
      // try next
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

if (verb === 'login' && target === 'antigravity') {
  const email = arg2
  if (!email) {
    console.error(usage)
    process.exit(1)
  }
  const env = readEnvConfig()
  const creds = await loginAntigravity({ onAuth, onPrompt, onProgress: log })
  const credentialFile: CredentialFile = {
    provider: 'google-antigravity',
    refreshToken: creds.refresh,
    accessToken: creds.access,
    expires: creds.expires,
    ...(typeof creds.projectId === 'string' ? { projectId: creds.projectId } : {})
  }
  await writeCredentials(env.authDir, email, credentialFile)
  console.log(`Logged in: antigravity/${email}`)
} else if (verb === 'login' && target === 'codex') {
  const env = readEnvConfig()
  const creds = await loginOpenAICodex({ onAuth, onPrompt, onProgress: log })
  const email = arg2 ?? discoverEmail(creds.access)
  const credentialFile: CredentialFile = {
    provider: 'openai-codex',
    refreshToken: creds.refresh,
    accessToken: creds.access,
    expires: creds.expires
  }
  await writeCredentials(env.authDir, email, credentialFile)
  console.log(`Logged in: openai-codex/${email}`)
} else if (verb === 'serve') {
  await import('./serve')
} else {
  console.error(usage)
  process.exit(1)
}
