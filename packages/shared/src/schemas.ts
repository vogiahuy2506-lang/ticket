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

export const ipnSchema = z.record(z.string(), z.union([z.string(), z.undefined()]));
