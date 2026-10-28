'use client';

import { useMemo, useState } from 'react';
import { computeFees, formatVnd } from '@tce/shared';
import { startCheckout } from '@/app/actions';
import { Badge } from '@/components/ui';

/**
 * The checkout form of one listing.
 *
 * The price breakdown has to follow the quantity *live*: the buyer has to
 * see what they are about to pay before they click "Pay", and the number
 * that is checked out has to be the one that was displayed. So the fees are
 * computed here, in the browser, from the same `computeFees` the server
 * uses - the server recomputes them anyway and refuses an order whose
 * amount does not match, so the two can never drift apart silently.
 */
export function ListingCheckoutForm({
  listingId,
  title,
  sellerName,
  priceVnd,
  available,
  quantitySold,
  quantityTotal,
  closed = false,
}: {
  listingId: string;
  title: string;
  sellerName: string;
  priceVnd: number;
  available: number;
  quantitySold: number;
  quantityTotal: number;
  /** the event is over: the checkout would be refused by the API */
  closed?: boolean;
}) {
  const max = Math.max(1, available);
  const [quantity, setQuantity] = useState(1);

  // The idempotency key is created once per mount and carries the
  // quantity. Two submits of the *same* quantity carry the same key, so a
  // double-tap cannot reserve the tickets twice. Changing the quantity
  // changes the key, because it is a different purchase - the server
  // would otherwise hand back the order it already created for the
  // previous quantity.
  const [keySeed] = useState(() => crypto.randomUUID());
  const idempotencyKey = `${listingId}-${quantitySold}-${quantity}-${keySeed}`;

  const soldOut = available <= 0;
  const lowStock = !soldOut && available <= 3;
  // A closed event is not the same as a sold-out listing: the tickets may
  // still be there, but the event is over and the checkout is refused.
  const notBuyable = soldOut || closed;

  const fees = useMemo(
    () => computeFees(priceVnd, Math.min(Math.max(quantity, 1), max)),
    [priceVnd, quantity, max],
  );

  const unitBuyerFee = Math.round((priceVnd * 10) / 100);
  const unitSellerFee = Math.round((priceVnd * 5) / 100);

  return (
    <form action={startCheckout} className="card card-interactive space-y-3.5">
      <input type="hidden" name="listingId" value={listingId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold leading-snug text-ink-900">{title}</p>
          <p className="mt-0.5 text-sm text-ink-500">
            Người bán: {sellerName}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="table-num text-lg font-bold leading-tight text-brand-700">
            {formatVnd(priceVnd)}
          </p>
          <p className="text-xs text-ink-400">/ vé</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {closed ? (
          <Badge tone="neutral">Sự kiện đã kết thúc</Badge>
        ) : soldOut ? (
          <Badge tone="danger">Hết vé</Badge>
        ) : lowStock ? (
          <Badge tone="warning">Chỉ còn {available} vé</Badge>
        ) : (
          <Badge tone="success">Còn {available} vé</Badge>
        )}
        <span className="text-xs text-ink-400">
          đã bán {quantitySold}/{quantityTotal}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`qty-${listingId}`}>
          Số lượng
        </label>
        <input
          id={`qty-${listingId}`}
          type="number"
          name="quantity"
          min={1}
          max={max}
          value={quantity}
          onChange={(e) => {
            const next = Number.parseInt(e.target.value, 10);
            setQuantity(Number.isNaN(next) ? 1 : Math.min(Math.max(next, 1), max));
          }}
          inputMode="numeric"
          disabled={notBuyable}
          className="input w-24 shrink-0"
        />
        {/* `min-w-0` lets the button shrink below its content
            width if the row is narrow; `whitespace-nowrap` keeps
            the label on one line instead of wrapping it. */}
        <button
          type="submit"
          disabled={notBuyable}
          className="btn-primary min-w-0 flex-1 whitespace-nowrap"
        >
          {closed ? 'Đã kết thúc' : soldOut ? 'Hết vé' : 'Thanh toán'}
        </button>
      </div>

      <dl className="grid grid-cols-2 gap-2 rounded-xl bg-ink-50/80 p-3 text-xs">
        <div>
          <dt className="text-ink-400">Phí dịch vụ bạn trả</dt>
          <dd className="mt-0.5 table-num font-semibold text-ink-800">
            +{formatVnd(fees.buyerFeeVnd)}
          </dd>
        </div>
        <div>
          <dt className="text-ink-400">Người bán nhận</dt>
          <dd className="mt-0.5 table-num font-semibold text-ink-800">
            {formatVnd(fees.sellerNetVnd)}
          </dd>
        </div>
      </dl>

      {/* The line the buyer actually cares about: the total for the
          quantity they picked, not for a single ticket. */}
      <div className="flex items-baseline justify-between gap-3 rounded-xl border border-brand-200 bg-brand-50 px-3 py-2.5">
        <span className="text-sm font-medium text-brand-900">
          Tổng người mua trả
          <span className="ml-1 text-xs font-normal text-brand-700">
            ({quantity} vé x {formatVnd(priceVnd)})
          </span>
        </span>
        <span className="table-num text-base font-bold text-brand-900">
          {formatVnd(fees.grossVnd)}
        </span>
      </div>

      <p className="text-[11px] leading-relaxed text-ink-400">
        Bạn giữ phần chênh lệch {formatVnd(unitBuyerFee + unitSellerFee)}/vé
        trong escrow đến khi sự kiện diễn ra. Vé được giữ 15 phút - hết thời
        gian thì vé được trả lại cho người bán.
      </p>
    </form>
  );
}
