import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

/** Spec 0041 FR4: a diagram that fails to render shows its source instead. */

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }))
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => {
      throw new Error('Parse error on line 1')
    }),
  },
}))

import { MermaidDiagram } from '@/components/docs/mermaid-diagram'

describe('MermaidDiagram', () => {
  it('falls back to the diagram source when rendering fails', async () => {
    const { container } = render(
      <MermaidDiagram chart="flowchart LR\n  A -->" />,
    )
    await waitFor(() =>
      expect(container.querySelector('[data-mermaid-fallback]')).not.toBeNull(),
    )
    expect(screen.getByText(/flowchart LR/)).toBeTruthy()
    expect(container.querySelector('[data-mermaid]')).toBeNull()
  })
})
