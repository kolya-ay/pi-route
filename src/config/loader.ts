export const interpolateEnvVars = (obj: unknown): unknown => {
  if (typeof obj === 'string') {
    if (!obj.startsWith('$')) return obj
    const varName = obj.slice(1)
    const value = process.env[varName]
    if (value === undefined) {
      throw new Error(`Environment variable "${varName}" is not set`)
    }
    return value
  }

  if (Array.isArray(obj)) {
    return obj.map(interpolateEnvVars)
  }

  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, interpolateEnvVars(v)])
    )
  }

  return obj
}
