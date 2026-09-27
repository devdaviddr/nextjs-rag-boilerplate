import { describe, expect, it } from 'vitest'

import { gateFailures, type GateMetrics } from '../../eval/gate'

// The release gate's comparison (#133).
const baseline: GateMetrics = {
  hitAt1: 0.941,
  hitAtK: 0.941,
  mrr: 0.941,
  refusalAccuracy: 1,
  crossKbLeakage: 0,
}

describe('gateFailures', () => {
  it('passes the baseline against itself', () => {
    expect(gateFailures(baseline, baseline)).toEqual([])
  })

  it('tolerates a small wobble in hit rates and MRR', () => {
    expect(
      gateFailures({ ...baseline, hitAt1: 0.9, mrr: 0.92 }, baseline, 0.05),
    ).toEqual([])
  })

  it('fails a real drop in retrieval quality', () => {
    expect(
      gateFailures({ ...baseline, hitAtK: 0.824 }, baseline, 0.05),
    ).toEqual([{ metric: 'hitAtK', baseline: 0.941, current: 0.824 }])
  })

  it('fails any drop in refusal accuracy, however small', () => {
    expect(
      gateFailures({ ...baseline, refusalAccuracy: 0.999 }, baseline, 0.5),
    ).toEqual([{ metric: 'refusalAccuracy', baseline: 1, current: 0.999 }])
  })

  it('fails any cross-knowledge-base leak', () => {
    expect(
      gateFailures({ ...baseline, crossKbLeakage: 1 }, baseline).map(
        (f) => f.metric,
      ),
    ).toEqual(['crossKbLeakage'])
  })
})
