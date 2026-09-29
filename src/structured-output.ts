// src/structured-output.ts

import type { IncomingRequest } from './types'

// Reserved name for the private tool the constrained-tool translation injects.
// Client tools are rejected alongside structured output, so this can never collide.
export const STRUCTURED_OUTPUT_TOOL = '__pi_route_structured_output'

// The one internal shape both inbound syntaxes normalize to. Strict enforcement is
// implied: pi-route only accepts schemas it intends to enforce, so an inbound
// `strict: false` never weakens the constraint.
export type StructuredOutput = {
  name: string
  description?: string | undefined
  schema: Record<string, unknown>
}

export class StructuredOutputRequestError extends Error {}

export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const toConstraint = (value: unknown): StructuredOutput => {
  const definition = asRecord(value)
  if (!definition) {
    throw new StructuredOutputRequestError('json_schema requires a definition object')
  }
  const { name, description, schema } = definition
  if (typeof name !== 'string' || name.trim() === '') {
    throw new StructuredOutputRequestError('json_schema requires a non-empty name')
  }
  if (description !== undefined && typeof description !== 'string') {
    throw new StructuredOutputRequestError('json_schema description must be a string')
  }
  const parameters = asRecord(schema)
  if (!parameters) {
    throw new StructuredOutputRequestError('json_schema requires an object schema')
  }
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    schema: parameters
  }
}

// Chat carries the definition under `response_format.json_schema`; Responses carries
// it inline on `text.format`. Anthropic has no structured-output syntax, so its
// bodies pass through untouched.
export const parseStructuredOutput = (
  format: IncomingRequest['format'],
  body: Record<string, unknown>
): StructuredOutput | undefined => {
  const requested =
    format === 'openai'
      ? asRecord(body.response_format)
      : format === 'responses'
        ? asRecord(asRecord(body.text)?.format)
        : undefined
  if (!requested) return undefined
  if (requested.type !== 'json_schema') {
    throw new StructuredOutputRequestError('only json_schema structured output is supported')
  }
  // One model turn cannot both call client tools and answer through the schema.
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    throw new StructuredOutputRequestError('structured output cannot be combined with tools')
  }
  return toConstraint(format === 'openai' ? requested.json_schema : requested)
}
