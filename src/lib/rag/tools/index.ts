import { logger } from '@/lib/logger'
import type { AnyAgentTool, ToolContext } from './types'

export { defineTool } from './types'
export type { AgentTool, AnyAgentTool, ToolContext, ToolResult } from './types'

/**
 * The tools the agentic planner may call, besides the built-in
 * `search_documents` and `read_figure` (spec 0044).
 *
 * Empty by default, so the planner's behaviour is exactly as measured. Add
 * yours here; `docs/extending.md` walks through writing one, and
 * `./examples/list-documents.ts` is a complete example.
 */
export const agentTools: AnyAgentTool[] = [
  // listDocumentsTool,
]

/** Names the built-in tools own; a registered tool may not take them. */
const BUILT_IN = new Set(['search_documents', 'read_figure'])

/**
 * The registry by name, checked: a duplicate name, or one that shadows a
 * built-in, is a mistake that would silently route calls to the wrong tool.
 */
export function toolRegistry(
  tools: readonly AnyAgentTool[] = agentTools,
): ReadonlyMap<string, AnyAgentTool> {
  const registry = new Map<string, AnyAgentTool>()
  for (const tool of tools) {
    if (BUILT_IN.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" would shadow a built-in tool.`)
    }
    if (registry.has(tool.name)) {
      throw new Error(`Two tools are registered as "${tool.name}".`)
    }
    registry.set(tool.name, tool)
  }
  return registry
}

/**
 * The tools in code plus the switched-on MCP tools (spec 0048), read fresh
 * for each question. An MCP tool whose name a tool in code already has is
 * left out rather than failing the question.
 */
export async function allAgentTools(): Promise<AnyAgentTool[]> {
  let loaded: AnyAgentTool[] = []
  try {
    const { mcpTools } = await import('./mcp')
    loaded = await mcpTools()
  } catch (error) {
    // No MCP tools is a safe answer; a failed question is not.
    logger.warn('MCP tools could not be loaded', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
  const taken = new Set([...BUILT_IN, ...agentTools.map((t) => t.name)])
  const fromMcp = loaded.filter((t) => {
    if (!taken.has(t.name)) return true
    logger.warn('MCP tool skipped: its name is taken', { tool: t.name })
    return false
  })
  return [...agentTools, ...fromMcp]
}

/** A tool as the planner's request advertises it. */
export function toolDefinition(tool: AnyAgentTool) {
  return {
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

/** Most of a tool's result any model is shown. */
export const TOOL_RESULT_CHARS = 2000

/**
 * Run one call from the planner (spec 0044 FR3, FR4, FR7, NFR2).
 *
 * Arguments the model sent that do not parse or do not fit the schema come
 * back as the step's text, so the planner can correct itself; they never
 * throw. A tool that throws is logged and returns null: a failed step, not a
 * failed answer. `context` comes from the server, never from the arguments.
 */
export async function runRegisteredTool(
  registry: ReadonlyMap<string, AnyAgentTool>,
  name: string,
  argumentsJson: string,
  context: ToolContext,
): Promise<{ text: string; tokens: number } | null> {
  const tool = registry.get(name)
  if (!tool) return { text: `There is no tool called "${name}".`, tokens: 0 }

  let raw: unknown
  try {
    raw = argumentsJson.trim() ? JSON.parse(argumentsJson) : {}
  } catch {
    return { text: `The arguments for ${name} were not valid JSON.`, tokens: 0 }
  }
  const parsed = tool.schema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`)
      .join('; ')
    return { text: `Invalid arguments for ${name}: ${issues}`, tokens: 0 }
  }

  const started = Date.now()
  try {
    const result = await tool.run(parsed.data, context)
    const text = (typeof result === 'string' ? result : result.text).slice(
      0,
      TOOL_RESULT_CHARS,
    )
    const tokens = typeof result === 'string' ? 0 : (result.tokens ?? 0)
    // What the agent did, as it did it (FR7): the activity drawer shows this.
    logger.info(`Called tool ${name}`, {
      category: 'agent',
      tool: name,
      arguments: raw,
      result: text.slice(0, 280),
      elapsedMs: Date.now() - started,
    })
    return { text, tokens }
  } catch (error) {
    logger.warn(`Tool ${name} failed`, {
      category: 'agent',
      tool: name,
      arguments: raw,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
