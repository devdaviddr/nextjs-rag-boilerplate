/**
 * Model prices for Observability's cost figures (#150), from
 * `RAG_MODEL_PRICES`: `model=price` pairs, comma-separated, in US dollars per
 * million tokens, e.g. `openai/gpt-4o=5, nvidia/nemotron-3-embed-1b=0`.
 *
 * One blended price per model: the steps of a run record their total tokens,
 * not input and output separately, so a split price could not be applied.
 * Pure, so the env schema can validate with it in any runtime.
 */

export type ModelPrices = ReadonlyMap<string, number>

/** The prices, or the first problem with the text. */
export function parseModelPrices(
  text: string | undefined,
): { ok: true; prices: ModelPrices } | { ok: false; error: string } {
  const prices = new Map<string, number>()
  for (const entry of (text ?? '').split(',')) {
    if (!entry.trim()) continue
    const at = entry.lastIndexOf('=')
    const model = entry.slice(0, at).trim()
    const price = Number(entry.slice(at + 1).trim())
    if (at <= 0 || !model || !Number.isFinite(price) || price < 0) {
      return {
        ok: false,
        error: `"${entry.trim()}" is not model=price (dollars per million tokens)`,
      }
    }
    prices.set(model, price)
  }
  return { ok: true, prices }
}

export interface CostSummary {
  /** Dollars for the priced tokens; null when no token was priced. */
  usd: number | null
  pricedTokens: number
  /** Tokens from models with no price: counted, never assumed free. */
  unpricedTokens: number
  byModel: { model: string; tokens: number; usd: number | null }[]
}

/** What `rows` of (model, tokens) cost at `prices`. */
export function summariseCost(
  rows: readonly { model: string | null; tokens: number | null }[],
  prices: ModelPrices,
): CostSummary {
  const tokensByModel = new Map<string, number>()
  for (const { model, tokens } of rows) {
    if (!tokens) continue
    const key = model ?? '(unknown)'
    tokensByModel.set(key, (tokensByModel.get(key) ?? 0) + tokens)
  }
  let usd: number | null = null
  let pricedTokens = 0
  let unpricedTokens = 0
  const byModel = [...tokensByModel]
    .sort((a, b) => b[1] - a[1])
    .map(([model, tokens]) => {
      const price = prices.get(model)
      if (price === undefined) {
        unpricedTokens += tokens
        return { model, tokens, usd: null }
      }
      const cost = (tokens / 1_000_000) * price
      usd = (usd ?? 0) + cost
      pricedTokens += tokens
      return { model, tokens, usd: cost }
    })
  return { usd, pricedTokens, unpricedTokens, byModel }
}

/** `$0.0123`, `$12.34`: enough digits to see a fraction of a cent. */
export function formatUsd(usd: number | null): string {
  if (usd === null) return '–'
  if (usd === 0) return '$0'
  return usd < 1 ? `$${usd.toPrecision(2)}` : `$${usd.toFixed(2)}`
}
