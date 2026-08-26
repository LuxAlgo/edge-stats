/*
  Shared date rules for the calendar generators. Everything here encodes
  published exchange rules; the generated JSON carries sources, a version,
  and a coverage horizon that CI's freshness check watches.
*/

export function iso(date) {
  return date.toISOString().slice(0, 10);
}

export function utc(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

export function weekdayUtc(date) {
  // 1 = Monday … 7 = Sunday
  const d = date.getUTCDay();
  return d === 0 ? 7 : d;
}

/** n-th <weekday> of a month (weekday: 1=Mon…7=Sun). */
export function nthWeekday(y, m, weekday, n) {
  let d = utc(y, m, 1);
  while (weekdayUtc(d) !== weekday) d = addDays(d, 1);
  return addDays(d, (n - 1) * 7);
}

export function lastWeekday(y, m, weekday) {
  let d = utc(y, m + 1, 1);
  d = addDays(d, -1);
  while (weekdayUtc(d) !== weekday) d = addDays(d, -1);
  return d;
}

/** Easter Sunday (Gregorian), anonymous/Butcher algorithm. */
export function easterSunday(y) {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(y, month, day);
}

export function goodFriday(y) {
  return addDays(easterSunday(y), -2);
}

/**
 * US-exchange observation shift: Saturday holidays are observed the Friday
 * before, Sunday holidays the Monday after. New Year's Day falling on a
 * Saturday is NOT observed (the Friday belongs to the old year).
 */
export function observed(date, { skipSaturday = false } = {}) {
  const wd = weekdayUtc(date);
  if (wd === 6) return skipSaturday ? null : addDays(date, -1);
  if (wd === 7) return addDays(date, 1);
  return date;
}
