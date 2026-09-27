import { z } from 'zod'

import { defineTool } from '../types'

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'a date as YYYY-MM-DD')
  .describe('A date as YYYY-MM-DD')

/**
 * An example tool (docs/extending.md): the number of days between two
 * dates. Documents give dates and deadlines; models are unreliable at
 * counting days between them. Not registered by default.
 */
export const daysBetweenTool = defineTool({
  name: 'days_between',
  description:
    'Count the days from one date to another. Call this when the answer ' +
    'depends on a number of days between two dates, instead of counting ' +
    'them yourself.',
  schema: z.object({ from: isoDate, to: isoDate }).strict(),
  async run({ from, to }) {
    const start = Date.parse(`${from}T00:00:00Z`)
    const end = Date.parse(`${to}T00:00:00Z`)
    if (Number.isNaN(start) || Number.isNaN(end)) return 'Not a real date.'
    const days = Math.round((end - start) / 86_400_000)
    return `${days} day${Math.abs(days) === 1 ? '' : 's'} from ${from} to ${to}.`
  },
})
