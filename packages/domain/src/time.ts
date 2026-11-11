/** Local calendar parts of an instant in a given IANA time zone. */
export interface LocalDateParts {
  year: number;
  /** 1-12 */
  month: number;
  /** 1-31 */
  day: number;
  /** ISO weekday: 1 = Monday ... 7 = Sunday. */
  isoWeekday: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function localDateParts(epochMs: number, timeZone: string): LocalDateParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochMs));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const isoWeekday = WEEKDAYS[get('weekday')];
  if (isoWeekday == null) throw new Error(`Unable to resolve weekday in time zone ${timeZone}`);
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    isoWeekday,
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** YYYY-MM-DD for the local day of an instant. */
export function localDateKey(epochMs: number, timeZone: string): string {
  const p = localDateParts(epochMs, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** YYYY-MM for the local month of an instant. */
export function localMonthKey(epochMs: number, timeZone: string): string {
  const p = localDateParts(epochMs, timeZone);
  return `${p.year}-${pad2(p.month)}`;
}

/** YYYY for the local year of an instant. */
export function localYearKey(epochMs: number, timeZone: string): string {
  return String(localDateParts(epochMs, timeZone).year);
}

/**
 * Key for the local ISO week (Monday start), expressed as that Monday's date (YYYY-MM-DD).
 * Using the Monday date avoids ISO week-year edge cases while still sorting correctly.
 */
export function localWeekKey(epochMs: number, timeZone: string): string {
  const p = localDateParts(epochMs, timeZone);
  return addDaysToDateKey(`${p.year}-${pad2(p.month)}-${pad2(p.day)}`, -(p.isoWeekday - 1));
}

/** Add whole days to a YYYY-MM-DD key (pure calendar arithmetic, no time zone). */
export function addDaysToDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** Add whole months to a YYYY-MM key. */
export function addMonthsToMonthKey(monthKey: string, months: number): string {
  const [y, m] = monthKey.split('-').map(Number) as [number, number];
  const total = y * 12 + (m - 1) + months;
  return `${Math.floor(total / 12)}-${pad2((total % 12) + 1)}`;
}
