import type { EnvPathOverrides } from '../config/env'

export const parseCliPathArgs = (
  argv: string[]
): { positionals: string[]; overrides: EnvPathOverrides } => {
  const positionals: string[] = []
  const overrides: EnvPathOverrides = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '-c' || arg === '--auth-dir') {
      const value = argv[i + 1]
      if (value === undefined || value === '-c' || value === '--auth-dir') {
        console.error(`Missing value for ${arg}`)
        process.exit(1)
      }
      if (arg === '-c') overrides.configPath = value
      else overrides.authDir = value
      i += 1
      continue
    }
    positionals.push(arg)
  }

  return { positionals, overrides }
}
