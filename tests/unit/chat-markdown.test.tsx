import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Markdown } from '@/components/chat/markdown'

/**
 * Assistant answers are model output derived from user-uploaded PDFs — the
 * indirect-injection surface named in spec 0025. These assert that raw HTML
 * stays inert, so a document that induces the model to emit markup cannot
 * turn it into DOM.
 */
describe('Markdown', () => {
  it('renders formatting rather than literal asterisks', () => {
    const { container } = render(<Markdown>{'- **Leave** – 20 days'}</Markdown>)
    expect(container.querySelector('strong')?.textContent).toBe('Leave')
    expect(container.querySelector('li')).not.toBeNull()
    expect(container.textContent).not.toContain('**')
  })

  it('renders a script tag as inert text, not as an element', () => {
    const { container } = render(
      <Markdown>{'Before <script>alert(1)</script> after'}</Markdown>,
    )
    expect(container.querySelector('script')).toBeNull()
    expect(container.innerHTML).not.toContain('<script')
  })

  it('does not create an element from an onerror image payload', () => {
    const { container } = render(
      <Markdown>{'<img src=x onerror="alert(1)">'}</Markdown>,
    )
    expect(container.querySelector('img')).toBeNull()
  })

  it('hardens links against opener and referrer leakage', () => {
    render(<Markdown>{'[docs](https://example.com)'}</Markdown>)
    const link = screen.getByRole('link', { name: 'docs' })
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(link.getAttribute('rel')).toContain('noreferrer')
    expect(link.getAttribute('rel')).toContain('nofollow')
  })

  it('supports GFM tables', () => {
    const { container } = render(
      <Markdown>{'| a | b |\n| - | - |\n| 1 | 2 |'}</Markdown>,
    )
    expect(container.querySelector('table')).not.toBeNull()
  })
})
