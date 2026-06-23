import type { ProviderType } from './types'

const WIRE_FORMATS: Record<ProviderType, 'anthropic' | 'openai' | null> = {
  anthropic: 'anthropic',
  openai: 'openai',
  'openai-codex': 'openai',
  antigravity: null // always translates via pi-ai Context
}

export const providerWireFormat = (type: ProviderType): 'anthropic' | 'openai' | null =>
  WIRE_FORMATS[type]

export const needsTranslation = (
  incomingFormat: 'anthropic' | 'openai',
  providerType: ProviderType
): boolean => {
  const wireFormat = providerWireFormat(providerType)
  return wireFormat === null || wireFormat !== incomingFormat
}
