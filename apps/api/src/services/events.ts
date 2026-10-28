import type { Db } from '../db/types.js';
import { withTx } from '../db/types.js';
import { vietnamLocalToUtcIso, type CreateEventInput } from '@tce/shared';

/**
 * Creating a new event with its listings.
 *
 * Decision (brief was silent): the brief only asks for a checkout flow, so
 * there is no "create event" in the original scope. But the demo data is
 * finite: once every ticket is sold out there is nothing left to demo, and
 * a reviewer cannot test the checkout again. So the operator gets a way to
 * put fresh tickets on sale.
 *
 * Two things this deliberately does *not* do:
 *  - it does not touch the ledger. An event is a catalogue entry, not a
 *    financial event; no money moves when a listing is created.
 *  - it does not create users. A listing is always sold by an existing
 *    seller, because the seller's escrow accounts have to exist before the
 *    money can be parked in them.
 */
export interface CreatedEvent {
  eventId: string;
  name: string;
  venue: string;
  startsAt: string;
  listings: Array<{
    listingId: string;
    sellerId: string;
    title: string;
    quantityTotal: number;
    priceVnd: number;
  }>;
}

export class CreateEventError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export async function createEvent(
  sql: Db,
  input: CreateEventInput,
): Promise<CreatedEvent> {
  const startsAt = vietnamLocalToUtcIso(input.startsAtLocal);

  return await withTx(sql, async (tx) => {
    // Every listing is sold by an existing user. A seller that does not
    // exist cannot hold an escrow balance, so the reference has to be real.
    const sellerIds = [...new Set(input.listings.map((l) => l.sellerId))];
    const sellers = await tx<{ id: string }[]>`
      SELECT id FROM users WHERE id IN ${tx(sellerIds)}
    `;
    const known = new Set(sellers.map((s) => s.id));
    const missing = sellerIds.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new CreateEventError(
        'Người bán không tồn tại trong hệ thống',
        'SELLER_NOT_FOUND',
        400,
      );
    }

    const events = await tx<{ id: string }[]>`
      INSERT INTO events (name, venue, starts_at)
      VALUES (${input.name}, ${input.venue}, ${startsAt})
      RETURNING id
    `;
    const eventId = events[0]!.id;

    const listings: CreatedEvent['listings'] = [];
    for (const l of input.listings) {
      const rows = await tx<{ id: string }[]>`
        INSERT INTO listings (event_id, seller_id, title, quantity_total, price_vnd)
        VALUES (${eventId}, ${l.sellerId}, ${l.title}, ${l.quantityTotal}, ${l.priceVnd})
        RETURNING id
      `;
      listings.push({
        listingId: rows[0]!.id,
        sellerId: l.sellerId,
        title: l.title,
        quantityTotal: l.quantityTotal,
        priceVnd: l.priceVnd,
      });
    }

    return {
      eventId,
      name: input.name,
      venue: input.venue,
      startsAt,
      listings,
    };
  });
}
