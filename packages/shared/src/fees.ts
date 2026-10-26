import { percentOf, subVnd, addVnd, vnd, type Vnd } from './money.js';

/**
 * Fee model (from the brief):
 *   - buyer pays listing price + 10% service fee
 *   - seller receives listing price - 5%
 *   - the platform keeps the difference (i.e. 10% + 5% = 15% of the subtotal)
 */
export const BUYER_FEE_PERCENT = 10;
export const SELLER_FEE_PERCENT = 5;

export interface FeeBreakdown {
  /** quantity * unit price, before any fee */
  subtotalVnd: Vnd;
  /** 10% of subtotal, paid by the buyer */
  buyerFeeVnd: Vnd;
  /** 5% of subtotal, withheld from the seller */
  sellerFeeVnd: Vnd;
  /** what the buyer actually pays: subtotal + buyer fee */
  grossVnd: Vnd;
  /** what the seller will receive once escrow is released */
  sellerNetVnd: Vnd;
  /** what the platform keeps: buyer fee + seller fee */
  platformFeeVnd: Vnd;
}

/**
 * Computes the full fee split for an order.
 *
 * Decision: both percentages are applied to the *subtotal* and each is
 * rounded half-up independently to whole VND. This guarantees the invariant
 * `grossVnd === sellerNetVnd + platformFeeVnd` (the ledger stays balanced for
 * every order, including odd amounts), which is what matters for accounting.
 */
export function computeFees(unitPriceVnd: number, quantity: number): FeeBreakdown {
  if (!Number.isSafeInteger(unitPriceVnd) || unitPriceVnd < 0) {
    throw new Error(`Invalid unit price: ${unitPriceVnd}`);
  }
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new Error(`Invalid quantity: ${quantity}`);
  }

  const subtotalVnd = vnd(unitPriceVnd * quantity);
  const buyerFeeVnd = percentOf(subtotalVnd, BUYER_FEE_PERCENT);
  const sellerFeeVnd = percentOf(subtotalVnd, SELLER_FEE_PERCENT);
  const grossVnd = addVnd(subtotalVnd, buyerFeeVnd);
  const sellerNetVnd = subVnd(subtotalVnd, sellerFeeVnd);
  const platformFeeVnd = addVnd(buyerFeeVnd, sellerFeeVnd);

  return {
    subtotalVnd,
    buyerFeeVnd,
    sellerFeeVnd,
    grossVnd,
    sellerNetVnd,
    platformFeeVnd,
  };
}
