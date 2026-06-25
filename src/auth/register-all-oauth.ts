// src/auth/register-all-oauth.ts

import {
  anthropicOAuthProvider,
  openaiCodexOAuthProvider,
  registerOAuthProvider
} from '@mariozechner/pi-ai/oauth'

import { antigravityOAuthProvider } from './antigravity-oauth'

export const registerAllOAuthProviders = (): void => {
  registerOAuthProvider(anthropicOAuthProvider)
  registerOAuthProvider(openaiCodexOAuthProvider)
  registerOAuthProvider(antigravityOAuthProvider)
}
