/**
 * Time formatting for the storefront.
 *
 * Decision (brief was silent): every timestamp in the app is shown in
 * Vietnam time (UTC+07:00). The obvious implementation - `new Date(x).
 * toLocaleString('vi-VN')` - silently depends on the *host* timezone, so
 * the same event shows a different time on a laptop in Hanoi, in a CI
 * runner and inside a UTC Docker container. The demo data is seeded with
 * `now() + interval '30 days'`, so a reviewer in a different timezone saw
 * a start time that was seven hours off.
 *
 * Vietnam has no daylight saving, so UTC+07:00 is a *fixed* offset. That
 * makes the conversion a plain subtraction, with no timezone database and
 * no locale surprises.
 */
const VIETNAM_OFFSET_MINUTES = 7 * 60;

/** The current Vietnamese wall-clock time, as `YYYY-MM-DDTHH:mm`. */
export function vietnamLocalNow(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + VIETNAM_OFFSET_MINUTES * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(
      shifted.getUTCDate(),
    )}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
  );
}

/**
 * A timestamp, shifted into Vietnam time and rendered with the Vietnamese
 * date and time format.
 *
 * `style: 'short'` gives `27/11/2026, 13:08`; `dateStyle: 'full'` gives
 * `Thứ Năm, 27 tháng 11, 2026`.
 */
export function formatDateTimeVi(
  value: string | Date,
  options: { dateStyle?: 'full' | 'long' | 'medium' | 'short'; timeStyle?: 'full' | 'long' | 'medium' | 'short' } = {
    dateStyle: 'medium',
    timeStyle: 'short',
  },
): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  const shifted = new Date(date.getTime() + VIETNAM_OFFSET_MINUTES * 60_000);
  // The shifted date is rendered with the UTC formatters, so the local
  // timezone of the server cannot change the result.
  return shifted.toLocaleString('vi-VN', {
    ...options,
    timeZone: 'UTC',
  });
}
