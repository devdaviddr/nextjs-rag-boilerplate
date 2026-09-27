import { z } from 'zod'

import { listReadyDocuments } from '../../retrieve'
import { defineTool } from '../types'

/**
 * An example tool (spec 0044): the titles of the documents this conversation
 * can read. Not registered by default. To offer it to the planner, add
 * `listDocumentsTool` to `agentTools` in `../index.ts`.
 *
 * Note what it does NOT take: a user or a knowledge base. Those come from
 * `context`, bound on the server, so the model cannot ask about anyone
 * else's documents.
 */
export const listDocumentsTool = defineTool({
  name: 'list_documents',
  description:
    "List the titles of the documents in the user's selected knowledge " +
    'bases. Call this when the question is about which documents exist, ' +
    'not about what they say.',
  schema: z.object({}).strict(),
  async run(_args, context) {
    const documents = await listReadyDocuments(
      context.userId,
      context.permittedKbIds,
    )
    if (documents.length === 0) return 'There are no documents in scope.'
    return documents.map((d) => `- ${d.title}`).join('\n')
  },
})
