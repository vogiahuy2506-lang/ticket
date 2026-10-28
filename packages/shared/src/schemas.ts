import { z } from 'zod';

export const checkoutSchema = z.object({
  listingId: z.string().uuid(),
  quantity: z.coerce.number().int().min(1).max(50),
});

export type CheckoutInput = z.infer<typeof checkoutSchema>;

export const switchUserSchema = z.object({
  userId: z.string().uuid(),
});

export const completeEventSchema = z.object({
  eventId: z.string().uuid(),
});

/**
 * One listing (a "batch of tickets" of one seller) of a new event.
 */
export const eventListingInputSchema = z.object({
  sellerId: z.string().uuid(),
  title: z.string().trim().min(1, 'Thiếu tên nhóm vé').max(120),
  quantityTotal: z.coerce.number().int().min(1).max(1000),
  priceVnd: z.coerce.number().int().min(0).max(1_000_000_000),
});

export type EventListingInput = z.infer<typeof eventListingInputSchema>;

/**
 * The payload of "create a new event".
 *
 * Decision (brief was silent): the brief only asks for a checkout, not for
 * an event-creation UI. But a demo whose tickets are all sold out has
 * nothing left to test, so the operator needs a way to put new tickets on
 * sale. The event starts at a local Vietnamese wall-clock time; Vietnam has
 * no daylight saving, so UTC+07:00 is a fixed offset and the conversion is
 * exact.
 */
export const createEventSchema = z.object({
  name: z.string().trim().min(1, 'Thiếu tên sự kiện').max(200),
  venue: z.string().trim().min(1, 'Thiếu địa điểm').max(200),
  /** local wall-clock time, `YYYY-MM-DDTHH:mm` in Asia/Ho_Chi_Minh */
  startsAtLocal: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Định dạng ngày giờ không hợp lệ'),
  listings: z.array(eventListingInputSchema).min(1, 'Cần ít nhất một nhóm vé'),
});

export type CreateEventInput = z.infer<typeof createEventSchema>;

/**
 * Converts a local Vietnamese wall-clock time to a UTC ISO timestamp.
 *
 * The offset is fixed at +07:00: Vietnam does not observe daylight saving,
 * so the local time is always UTC+7 and the conversion never needs a
 * timezone database. Doing it here (not in the browser) keeps the server
 * and the client from disagreeing about what "20:00 ngày 27/11" means.
 */
export function vietnamLocalToUtcIso(local: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) throw new Error(`Invalid local datetime: ${local}`);
  const [, y, mo, d, h, mi] = m;
  const ms = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
  );
  if (Number.isNaN(ms)) throw new Error(`Invalid local datetime: ${local}`);
  return new Date(ms - 7 * 60 * 60 * 1000).toISOString();
}

export const ipnSchema = z.record(z.string(), z.union([z.string(), z.undefined()]));
