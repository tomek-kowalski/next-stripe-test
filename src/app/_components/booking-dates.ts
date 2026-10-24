// Booking date defaults and validation (pure, so they can be unit-tested).

export const DEFAULT_RENTAL_DAYS = 3;

/** Local calendar date as YYYY-MM-DD (not UTC, which is off by a day around midnight in Poland). */
export function localIsoDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Adds whole days to a YYYY-MM-DD date. */
export function addDays(isoDay: string, days: number): string {
  const [y, m, d] = isoDay.split("-").map(Number);
  return localIsoDay(new Date(y, m - 1, d + days));
}

/** Empty start → today; empty end → start + 3 days (never before the start). */
export function resolveBookingDates(start: string, end: string, today: Date): { start: string; end: string } {
  const s = start || localIsoDay(today);
  return { start: s, end: end || addDays(s, DEFAULT_RENTAL_DAYS) };
}

/** Polish message when both dates are set and the end is before the start; null otherwise. */
export function bookingDatesError(start: string, end: string): string | null {
  return start && end && end < start ? "Data zakończenia nie może być wcześniejsza niż data rozpoczęcia." : null;
}
