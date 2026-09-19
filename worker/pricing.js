export const PRICE_CENTS = { low: 199, medium: 299, high: 499 };

export function priceForConfidence(confidence) {
  const cents = PRICE_CENTS[confidence];
  if (cents === undefined) {
    throw new Error(`Unknown confidence level: ${confidence}`);
  }
  return cents;
}

export function bundlePrice(cents) {
  return Math.round(cents * 0.8);
}
