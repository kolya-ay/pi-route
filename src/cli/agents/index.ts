// src/cli/agents/index.ts

import type { Agent } from '../agent'
import { claude } from './claude'
import { codex } from './codex'
import { omp } from './omp'
import { openclaw } from './openclaw'
import { opencode } from './opencode'
import { pi } from './pi'
import { qwen } from './qwen'
import { zed } from './zed'

export const AGENTS: Agent[] = [claude, codex, omp, opencode, openclaw, pi, qwen, zed]
