import { describe, expect, it } from 'vitest'

import {
  acceptanceCounts,
  changelogRequired,
  changelogSection,
  compareVersions,
  isFinishedButProposed,
  linkedIssues,
  nextVersion,
  parseHeader,
  prProblems,
  sectionHasEntries,
} from '../../scripts/process-rules.mjs'

describe('parseHeader', () => {
  it('reads type, scope, breaking flag and subject', () => {
    expect(parseHeader('feat(rag)!: drop the v1 index')).toEqual({
      type: 'feat',
      scope: 'rag',
      breaking: true,
      subject: 'drop the v1 index',
    })
    expect(parseHeader('docs: fix a typo')).toMatchObject({
      type: 'docs',
      scope: null,
      breaking: false,
    })
  })

  it('rejects a header that is not Conventional', () => {
    expect(parseHeader('Update README')).toBeNull()
    expect(parseHeader('feat:no space')).toBeNull()
  })
})

describe('linkedIssues', () => {
  it('finds closing and tracking keywords, case-insensitively', () => {
    expect(
      linkedIssues('Closes #12\nfixes #3, and resolves #7. Part of #19.'),
    ).toEqual([3, 7, 12, 19])
  })

  it('ignores a bare mention', () => {
    expect(linkedIssues('Related to #12, see #3')).toEqual([])
    expect(linkedIssues(undefined)).toEqual([])
  })
})

describe('changelogRequired', () => {
  it('requires an entry for user-facing and breaking changes only', () => {
    expect(changelogRequired('feat(chat): stream answers')).toBe(true)
    expect(changelogRequired('fix: reject empty uploads')).toBe(true)
    expect(changelogRequired('refactor(api)!: rename the route')).toBe(true)
    expect(changelogRequired('docs: explain reranking')).toBe(false)
    expect(changelogRequired('chore(deps): bump next')).toBe(false)
  })
})

describe('prProblems', () => {
  const good = {
    title: 'feat(rag): add reranking',
    body: 'Closes #16',
    labels: [],
    author: 'devdaviddr',
    changedFiles: ['src/lib/rag/rerank.ts', 'CHANGELOG.md'],
  }

  it('passes a well-formed PR', () => {
    expect(prProblems(good)).toEqual([])
  })

  it('flags a title that is not Conventional', () => {
    expect(prProblems({ ...good, title: 'Add reranking' })).toHaveLength(1)
  })

  it('flags a missing issue link, except for bots', () => {
    expect(prProblems({ ...good, body: 'Adds reranking.' })).toHaveLength(1)
    expect(prProblems({ ...good, body: '', author: 'renovate[bot]' })).toEqual(
      [],
    )
  })

  it('flags a user-facing change with no CHANGELOG entry, unless labelled', () => {
    const noLog = { ...good, changedFiles: ['src/lib/rag/rerank.ts'] }
    expect(prProblems(noLog)).toHaveLength(1)
    expect(prProblems({ ...noLog, labels: ['no-changelog'] })).toEqual([])
    expect(
      prProblems({ ...noLog, title: 'refactor(rag): split rerank' }),
    ).toEqual([])
  })
})

describe('nextVersion', () => {
  it('pre-1.0: feat or breaking bumps the minor, anything else the patch', () => {
    expect(nextVersion('0.20.1', ['fix: a', 'docs: b'])).toEqual({
      version: '0.20.2',
      bump: 'patch',
    })
    expect(nextVersion('v0.20.1', ['fix: a', 'feat(rag): b'])).toEqual({
      version: '0.21.0',
      bump: 'minor',
    })
    expect(
      nextVersion('0.20.1', ['refactor: a\n\nBREAKING CHANGE: renamed']),
    ).toEqual({ version: '0.21.0', bump: 'minor' })
  })

  it('from 1.0: breaking → major, feat → minor, else patch', () => {
    expect(nextVersion('1.4.2', ['feat!: x']).version).toBe('2.0.0')
    expect(nextVersion('1.4.2', ['feat: x']).version).toBe('1.5.0')
    expect(nextVersion('1.4.2', ['perf: x']).version).toBe('1.4.3')
  })

  it('ignores commits that are not Conventional', () => {
    expect(nextVersion('0.20.1', ['Merge branch main'])).toEqual({
      version: null,
      bump: 'none',
    })
  })
})

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    expect(compareVersions('v0.10.0', 'v0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('0.20.1', 'v0.20.1')).toBe(0)
  })
})

describe('changelog sections', () => {
  const log = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '### Added',
    '',
    '## [0.21.0] - 2026-10-01',
    '',
    '### Fixed',
    '',
    '- Something.',
    '',
    '## [0.20.1] - 2026-09-10',
  ].join('\n')

  it('returns one section, bounded by the next heading', () => {
    expect(changelogSection(log, '0.21.0')).toContain('- Something.')
    expect(changelogSection(log, '0.21.0')).not.toContain('0.20.1')
    expect(changelogSection(log, '9.9.9')).toBeNull()
  })

  it('treats a section with only ### headings as empty', () => {
    expect(sectionHasEntries(changelogSection(log, 'Unreleased')!)).toBe(false)
    expect(sectionHasEntries(changelogSection(log, '0.21.0')!)).toBe(true)
  })
})

describe('finished specs', () => {
  const spec = (criteria: string) =>
    [
      '## Goals',
      '- [ ] not a criterion',
      '## Acceptance criteria',
      criteria,
      '## Security & privacy',
      '- [ ] also not a criterion',
    ].join('\n')

  it('counts only boxes inside the acceptance criteria section', () => {
    expect(acceptanceCounts(spec('- [x] a\n- [X] b\n- [ ] c'))).toEqual({
      ticked: 2,
      open: 1,
    })
  })

  it('flags a Proposed spec whose criteria are all ticked', () => {
    const done = acceptanceCounts(spec('- [x] a\n- [x] b'))
    expect(isFinishedButProposed('Proposed', done)).toBe(true)
    expect(isFinishedButProposed('Shipped', done)).toBe(false)
    expect(
      isFinishedButProposed('Proposed', acceptanceCounts(spec('- [ ] a'))),
    ).toBe(false)
  })
})
