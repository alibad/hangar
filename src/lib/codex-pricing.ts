// Current standard short-context API-rate equivalents, NOT subscription bills.
// Sources checked 2026-09-12:
// https://developers.openai.com/api/docs/pricing
// https://developers.openai.com/api/docs/models/gpt-5.5
// https://developers.openai.com/api/docs/models/gpt-5.4
// All historical activity is valued at this reference rate, not historical rates.
export const PRICING_DATE = "2026-09-12";
// USD per million [uncached input, cache read, cache write, output].
const PRICES: Record<string, [number, number, number, number]> = {
  "gpt-6-astra": [10, 1, 12.5, 50],
  "gpt-5.6-sol": [4, 0.4, 5, 20],
  "gpt-5.6-terra": [2, 0.2, 2.5, 12],
  "gpt-5.6-luna": [0.2, 0.02, 0.25, 1.2],
  "gpt-5.5": [5, 0.5, 5, 30],
  "gpt-5.4": [2.5, 0.25, 2.5, 15],
};
export function estimateCodexCost(e: {
  model: string;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
}): number | null {
  const price = PRICES[e.model.replace(/-\d{4}-\d{2}-\d{2}$/, "")];
  if (!price) return null;
  return (
    ((e.input - e.cached - e.cacheWrite) * price[0] +
      e.cached * price[1] +
      e.cacheWrite * price[2] +
      e.output * price[3]) /
    1e6
  );
}
