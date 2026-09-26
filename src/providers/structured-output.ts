// src/providers/structured-output.ts

import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  ToolCall
} from '@earendil-works/pi-ai'

import { STRUCTURED_OUTPUT_TOOL, type StructuredOutput } from '../structured-output'
import type { FormatTranslationMode } from '../types'

// What dispatch needs to enforce a schema on one candidate: the context it must
// stream, the extra stream options, and whether the public response has to be
// rebuilt from the private tool call.
export type StructuredOutputPlan = {
  context: Context
  options: Record<string, unknown>
  normalizeEvents: boolean
}

// Native enforcement is only claimed for adapters whose wire body pi-route knows
// AND which actually forward `samplingParams` (openai-completions / -responses do;
// the Codex adapter builds its body by hand and drops them).
const nativeParams = (
  api: Api,
  constraint: StructuredOutput
): Record<string, unknown> | undefined => {
  const described =
    constraint.description !== undefined ? { description: constraint.description } : {}
  if (api === 'openai-completions') {
    return {
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: constraint.name,
          ...described,
          strict: true,
          schema: constraint.schema
        }
      }
    }
  }
  if (api === 'openai-responses') {
    return {
      text: {
        format: {
          type: 'json_schema',
          name: constraint.name,
          ...described,
          strict: true,
          schema: constraint.schema
        }
      }
    }
  }
  return undefined
}

// Forced selection of the private tool. Codex Responses accepts only the coarse
// "required", which is exact here because the private tool is the only tool.
const forcedToolChoice = (api: Api): unknown => {
  if (api === 'anthropic-messages') return { type: 'tool', name: STRUCTURED_OUTPUT_TOOL }
  if (api === 'openai-completions') {
    return { type: 'function', function: { name: STRUCTURED_OUTPUT_TOOL } }
  }
  if (api === 'openai-responses') return { type: 'function', name: STRUCTURED_OUTPUT_TOOL }
  if (api === 'openai-codex-responses') return 'required'
  return undefined
}

const unsupported = (mode: FormatTranslationMode, api: Api): never => {
  throw new Error(`formatTranslation ${mode} cannot enforce json_schema for API ${api}`)
}

const constrainedPlan = (
  api: Api,
  context: Context,
  constraint: StructuredOutput,
  mode: FormatTranslationMode
): StructuredOutputPlan => {
  const toolChoice = forcedToolChoice(api)
  if (toolChoice === undefined) unsupported(mode, api)
  // The route already rejects client tools alongside structured output; a context
  // that still carries them means the schema would not be the only answer path.
  if (context.tools !== undefined && context.tools.length > 0) {
    throw new Error('structured output cannot be combined with tools')
  }
  return {
    context: {
      ...context,
      tools: [
        {
          name: STRUCTURED_OUTPUT_TOOL,
          description: constraint.description ?? `Return ${constraint.name}`,
          parameters: constraint.schema,
          constrainedSampling: { type: 'json_schema', strict: 'require' }
        }
      ]
    },
    options: { toolChoice },
    normalizeEvents: true
  }
}

export const prepareStructuredOutput = (
  model: Model<Api>,
  context: Context,
  constraint: StructuredOutput,
  mode: FormatTranslationMode
): StructuredOutputPlan => {
  const api = model.api
  if (mode === 'constrained-tool') return constrainedPlan(api, context, constraint, mode)

  const samplingParams = nativeParams(api, constraint)
  if (samplingParams) return { context, options: { samplingParams }, normalizeEvents: false }
  if (mode === 'native') unsupported(mode, api)
  return constrainedPlan(api, context, constraint, mode)
}

// --- Private-tool response normalization ---

const isPrivateCall = (content: AssistantMessage['content'][number]): content is ToolCall =>
  content.type === 'toolCall' && content.name === STRUCTURED_OUTPUT_TOOL

const finalText = (message: AssistantMessage, streamed: string): string => {
  // Reasoning backends keep thinking blocks alongside the answer; the schema
  // document itself must still be exactly one private tool call.
  const answers = message.content.filter((part) => part.type !== 'thinking')
  const [only, ...rest] = answers
  if (!only || rest.length > 0 || !isPrivateCall(only)) {
    throw new Error('structured output expected exactly one schema tool call')
  }
  // Streamed bytes are authoritative: re-serializing parsed arguments would change
  // whitespace and property order the client may be streaming already.
  return streamed || JSON.stringify(only.arguments)
}

const requireJson = (text: string): string => {
  try {
    JSON.parse(text)
  } catch {
    throw new Error('structured output produced invalid JSON')
  }
  return text
}

// Rewrites the private tool call into ordinary assistant text so the public Chat and
// Responses serializers never see it. Anything else the backend emits fails closed.
export const normalizeStructuredOutputEvents = async function* (
  events: AsyncIterable<AssistantMessageEvent>
): AsyncIterable<AssistantMessageEvent> {
  let streamed = ''
  for await (const event of events) {
    switch (event.type) {
      // Thinking is a separate channel from the answer: the serializers already
      // route it away from message content, so it passes through untouched.
      case 'start':
      case 'error':
      case 'thinking_start':
      case 'thinking_delta':
      case 'thinking_end':
        yield event
        break

      case 'toolcall_start':
        yield { type: 'text_start', contentIndex: event.contentIndex, partial: event.partial }
        break

      case 'toolcall_delta':
        streamed += event.delta
        yield {
          type: 'text_delta',
          contentIndex: event.contentIndex,
          delta: event.delta,
          partial: event.partial
        }
        break

      case 'toolcall_end': {
        if (event.toolCall.name !== STRUCTURED_OUTPUT_TOOL) {
          throw new Error(
            `structured output received an unexpected tool call: ${event.toolCall.name}`
          )
        }
        const content = streamed || JSON.stringify(event.toolCall.arguments)
        yield {
          type: 'text_end',
          contentIndex: event.contentIndex,
          content,
          partial: event.partial
        }
        break
      }

      case 'done': {
        const text = requireJson(finalText(event.message, streamed))
        yield {
          type: 'done',
          reason: 'stop',
          message: { ...event.message, content: [{ type: 'text', text }], stopReason: 'stop' }
        }
        break
      }

      default:
        throw new Error(`structured output received an unexpected ${event.type} event`)
    }
  }
}
