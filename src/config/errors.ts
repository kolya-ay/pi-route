export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

// "There is no config file yet" — the one config failure a caller may legitimately
// shrug off (e.g. `provider login` on a fresh machine). Everything else, including
// a config that exists but doesn't parse, stays a plain ConfigError and must surface.
export class ConfigNotFoundError extends ConfigError {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigNotFoundError'
  }
}
