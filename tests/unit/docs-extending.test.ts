import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// docs/extending.md shows the example tool in full. This keeps the page and
// the file (which is type-checked and tested) from drifting apart (#149).
describe('docs/extending.md', () => {
  it('shows days-between.ts exactly as it is', () => {
    const doc = readFileSync('docs/extending.md', 'utf8')
    const file = readFileSync(
      'src/lib/rag/tools/examples/days-between.ts',
      'utf8',
    ).trimEnd()
    const shown = doc.match(
      /```ts\n(import \{ z \} from 'zod'[\s\S]*?)\n```/,
    )?.[1]
    expect(shown).toBe(file)
  })
})
