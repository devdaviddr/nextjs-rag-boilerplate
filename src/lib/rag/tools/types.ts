import { z } from 'zod'

/**
 * A tool the agentic planner can call (spec 0044).
 *
 * The model chooses a registered tool and supplies its arguments, and nothing
 * else: scope (`ToolContext`) is bound on the server from the session and the
 * conversation, exactly as it is for `search_documents` (spec 0028).
 */

/** What a tool may know about the request. Never taken from the model. */
export interface ToolContext {
  userId: string
  /** The knowledge bases this conversation may read. */
  permittedKbIds: readonly string[]
  /** Carries whatever is left of the loop's time budget. */
  signal: AbortSignal
}

export interface ToolResult {
  /** What the planner, the answer writer and the verifier are shown. */
  text: string
  /** Tokens the tool spent, if it called a model; counted against the loop. */
  tokens?: number
}

export interface AgentTool<Args = unknown> {
  /** `[A-Za-z0-9_-]{1,64}`, as OpenAI-compatible tool calling requires. */
  name: string
  /** Tells the model when to call it. Write it for the model. */
  description: string
  /** Validates the model's arguments before `run` sees them. */
  schema: z.ZodType<Args>
  /** The JSON Schema the model is shown, derived from `schema`. */
  parameters: Record<string, unknown>
  run(args: Args, context: ToolContext): Promise<ToolResult | string>
}

/**
 * Any tool, whatever its arguments: what the registry holds. (`AgentTool` is
 * contravariant in `Args` through `run`, so `AgentTool<unknown>` would not
 * accept a tool with real arguments.)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAgentTool = AgentTool<any>

const NAME = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Build a tool from a Zod schema. The model is shown the schema as JSON
 * Schema; the arguments it sends are validated against the same schema, so
 * the two cannot disagree.
 */
export function defineTool<Args>(definition: {
  name: string
  description: string
  schema: z.ZodType<Args>
  run(args: Args, context: ToolContext): Promise<ToolResult | string>
}): AgentTool<Args> {
  if (!NAME.test(definition.name)) {
    throw new Error(
      `Tool name "${definition.name}" must match ${NAME} (letters, digits, _ and -).`,
    )
  }
  // `$schema` is JSON Schema's own header; the tool format does not use it.
  const { $schema: _unused, ...parameters } = z.toJSONSchema(
    definition.schema,
  ) as Record<string, unknown>
  return { ...definition, parameters }
}
