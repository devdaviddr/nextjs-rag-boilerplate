/**
 * The release gate's comparison (#133): this run's fixed-pipeline metrics
 * against a saved baseline. Pure, so it is unit-tested without running an
 * evaluation.
 *
 * Refusal accuracy and cross-KB leakage are absolute: any drop in refusal, or
 * any leak, fails. Hit rates and MRR move a little between runs of the same
 * code (the endpoint's embeddings are not bit-stable), so they fail only when
 * they fall by more than `tolerance`.
 */

export interface GateMetrics {
  hitAt1: number
  hitAtK: number
  mrr: number
  refusalAccuracy: number
  crossKbLeakage: number
}

export interface GateFailure {
  metric: keyof GateMetrics
  baseline: number
  current: number
}

export const DEFAULT_TOLERANCE = 0.05

export function gateFailures(
  current: GateMetrics,
  baseline: GateMetrics,
  tolerance = DEFAULT_TOLERANCE,
): GateFailure[] {
  const failures: GateFailure[] = []
  const fail = (metric: keyof GateMetrics) =>
    failures.push({
      metric,
      baseline: baseline[metric],
      current: current[metric],
    })

  if (current.refusalAccuracy < baseline.refusalAccuracy)
    fail('refusalAccuracy')
  if (current.crossKbLeakage > 0) fail('crossKbLeakage')
  for (const metric of ['hitAt1', 'hitAtK', 'mrr'] as const) {
    if (current[metric] < baseline[metric] - tolerance) fail(metric)
  }
  return failures
}
