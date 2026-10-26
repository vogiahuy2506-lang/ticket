/**
 * Money handling rules for the whole app.
 *
 * Decision (brief was silent): all monetary amounts are integers in VND.
 * VND has no commonly circulating subunit, so integer VND avoids the
 * rounding drift that float/decimal handling introduces for every fee split.
 */

export type Vnd = number & { readonly __brand: 'Vnd' };

/** Asserts that a value is a safe, non-negative integer amount of VND. */
export function vnd(value: number): Vnd {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Invalid VND amount: ${value} (must be a safe integer)`);
  }
  return value as Vnd;
}

/** Adds amounts, keeping the integer invariant. */
export function addVnd(...amounts: number[]): Vnd {
  return vnd(amounts.reduce((sum, a) => sum + a, 0));
}

/** Subtracts amounts, keeping the integer invariant. */
export function subVnd(a: number, b: number): Vnd {
  return vnd(a - b);
}

const VND_FORMAT = new Intl.NumberFormat('vi-VN', {
  maximumFractionDigits: 0,
});

/** "1.200.000 ₫" - Vietnamese formatting, no decimals. */
export function formatVnd(amount: number): string {
  return `${VND_FORMAT.format(amount)} ₫`;
}

/**
 * Percentage of an amount, rounded half-up to the nearest VND.
 * Used for the 10% buyer fee and the 5% seller fee.
 */
export function percentOf(amount: number, percent: number): Vnd {
  return vnd(Math.round((amount * percent) / 100));
}
