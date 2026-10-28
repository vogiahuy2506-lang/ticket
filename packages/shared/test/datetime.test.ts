import { describe, expect, it } from 'vitest';
import {
  createEventSchema,
  vietnamLocalToUtcIso,
} from '../src/schemas.js';
import { formatDateTimeVi, vietnamLocalNow } from '../src/datetime.js';

describe('vietnam local time', () => {
  it('converts a local wall-clock time to UTC with the fixed +07:00 offset', () => {
    // Vietnam has no daylight saving, so the offset is always +07:00.
    expect(vietnamLocalToUtcIso('2026-11-27T20:00')).toBe(
      '2026-11-27T13:00:00.000Z',
    );
    expect(vietnamLocalToUtcIso('2026-01-01T00:00')).toBe(
      '2025-12-31T17:00:00.000Z',
    );
  });

  it('rejects a malformed local datetime', () => {
    expect(() => vietnamLocalToUtcIso('27/11/2026 20:00')).toThrow();
    expect(() => vietnamLocalToUtcIso('2026-11-27')).toThrow();
  });

  it('renders the current local time as a datetime-local value', () => {
    // 2026-01-01T00:00:00Z is 07:00 on the same day in Vietnam.
    expect(vietnamLocalNow(new Date('2026-01-01T00:00:00Z'))).toBe(
      '2026-01-01T07:00',
    );
    // 2025-12-31T18:00:00Z is 01:00 on the next day in Vietnam.
    expect(vietnamLocalNow(new Date('2025-12-31T18:00:00Z'))).toBe(
      '2026-01-01T01:00',
    );
  });
});

describe('formatDateTimeVi', () => {
  it('shows the Vietnam time regardless of the host timezone', () => {
    // The whole point of the helper: the same instant must render the same
    // way on a laptop in Hanoi, in CI and inside a UTC Docker container.
    // 13:00 UTC is 20:00 in Vietnam (+07:00).
    const value = '2026-11-27T13:00:00.000Z';
    const rendered = formatDateTimeVi(value, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    expect(rendered).toContain('20:00');
    expect(rendered).toContain('27');
  });

  it('accepts a Date as well as a string', () => {
    const rendered = formatDateTimeVi(new Date('2026-11-27T13:00:00.000Z'), {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    expect(rendered).toContain('20:00');
  });
});

describe('createEventSchema', () => {
  const valid = {
    name: 'Đại nhạc Sơn Trà - Đêm Mưa',
    venue: 'Sân Văn Hoá TP.HCM',
    startsAtLocal: '2026-11-27T20:00',
    listings: [
      {
        sellerId: '11111111-1111-4111-8111-111111111111',
        title: 'Vé Standard',
        quantityTotal: 10,
        priceVnd: 500_000,
      },
    ],
  };

  it('accepts a well-formed event', () => {
    const parsed = createEventSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
  });

  it('requires at least one listing', () => {
    const parsed = createEventSchema.safeParse({ ...valid, listings: [] });
    expect(parsed.success).toBe(false);
  });

  it('requires a name and a venue', () => {
    expect(createEventSchema.safeParse({ ...valid, name: '  ' }).success).toBe(
      false,
    );
    expect(createEventSchema.safeParse({ ...valid, venue: '' }).success).toBe(
      false,
    );
  });

  it('requires a datetime in the YYYY-MM-DDTHH:mm shape', () => {
    expect(
      createEventSchema.safeParse({ ...valid, startsAtLocal: '2026-11-27' })
        .success,
    ).toBe(false);
    expect(
      createEventSchema.safeParse({ ...valid, startsAtLocal: '27/11/2026' })
        .success,
    ).toBe(false);
  });

  it('rejects a listing with a zero quantity or a negative price', () => {
    const zero = createEventSchema.safeParse({
      ...valid,
      listings: [{ ...valid.listings[0], quantityTotal: 0 }],
    });
    expect(zero.success).toBe(false);

    const negative = createEventSchema.safeParse({
      ...valid,
      listings: [{ ...valid.listings[0], priceVnd: -1 }],
    });
    expect(negative.success).toBe(false);
  });
});
