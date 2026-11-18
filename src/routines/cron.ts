/**
 * Standard 5-field cron expressions (minute hour day-of-month month day-of-week), evaluated in local time.
 * Supports `*`, values, ranges, steps (`*／n`, `a-b/n`, `a/n`), lists, month and weekday names, and the
 * `@hourly`/`@daily`/`@midnight`/`@weekly`/`@monthly`/`@yearly`/`@annually` macros. As in Vixie cron,
 * when both day-of-month and day-of-week are restricted, a day matching either one matches.
 */
export interface Cron {
  source: string;
  minutes: number[];
  hours: number[];
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Day-of-month / day-of-week was `*` (or started with `*`, like `*／2`). */
  anyDay: boolean;
  anyWeekday: boolean;
}

const MACROS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** Value of the first name (months start at 1, weekdays at 0). */
  nameBase?: number;
}

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, nameBase: 1 },
  // 7 is accepted as Sunday and folded into 0.
  { name: "day of week", min: 0, max: 7, names: WEEKDAYS, nameBase: 0 },
];

function value(text: string, spec: FieldSpec): number {
  const named = spec.names?.indexOf(text.toLowerCase()) ?? -1;
  if (named >= 0) return named + spec.nameBase!;
  if (!/^\d+$/.test(text)) throw new Error(`${spec.name}: "${text}" is not a number`);
  const n = Number(text);
  if (n < spec.min || n > spec.max) throw new Error(`${spec.name}: ${n} is outside ${spec.min}-${spec.max}`);
  return n;
}

function parseField(text: string, spec: FieldSpec): number[] {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    if (!part) throw new Error(`${spec.name}: empty list item in "${text}"`);
    const [range, stepText, extra] = part.split("/");
    if (extra !== undefined) throw new Error(`${spec.name}: "${part}" has more than one "/"`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) === 0) throw new Error(`${spec.name}: step "${stepText}" must be a positive number`);
      step = Number(stepText);
    }
    let lo: number;
    let hi: number;
    if (range === "*") [lo, hi] = [spec.min, spec.max];
    else if (range!.includes("-")) {
      const [a, b, more] = range!.split("-");
      if (more !== undefined || !a || !b) throw new Error(`${spec.name}: bad range "${range}"`);
      [lo, hi] = [value(a, spec), value(b, spec)];
      if (lo > hi) throw new Error(`${spec.name}: range "${range}" goes backwards`);
    } else {
      lo = value(range!, spec);
      // `a/n` means from a to the end of the field.
      hi = stepText !== undefined ? spec.max : lo;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/** Parses a cron expression; throws an Error saying what is wrong. */
export function parseCron(expr: string): Cron {
  const source = expr.trim();
  const expanded = MACROS[source.toLowerCase()] ?? source;
  if (expanded.startsWith("@")) throw new Error(`unknown macro "${source}"`);
  const parts = expanded.split(/\s+/).filter(Boolean);
  if (parts.length !== 5) throw new Error(`expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`);
  const [minutes, hours, days, months, weekdays] = parts.map((p, i) => parseField(p, FIELDS[i]!));
  return {
    source,
    minutes: minutes!,
    hours: hours!,
    days: new Set(days),
    months: new Set(months),
    weekdays: new Set(weekdays!.map((d) => d % 7)),
    anyDay: parts[2]!.startsWith("*"),
    anyWeekday: parts[4]!.startsWith("*"),
  };
}

/** Whether the cron fires on this local calendar day (ignoring the time). */
export function matchesDay(c: Cron, d: Date): boolean {
  if (!c.months.has(d.getMonth() + 1)) return false;
  const dom = c.days.has(d.getDate());
  const dow = c.weekdays.has(d.getDay());
  if (c.anyDay && c.anyWeekday) return true;
  if (c.anyDay) return dow;
  if (c.anyWeekday) return dom;
  return dom || dow;
}

/** Whether the cron fires at this local minute. */
export function matches(c: Cron, d: Date): boolean {
  return matchesDay(c, d) && c.hours.includes(d.getHours()) && c.minutes.includes(d.getMinutes());
}

/** Local midnight at the start of the day `t` falls on. */
export function startOfDay(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function sameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

/**
 * The latest time today, at or before `now`, that the cron fires; null if it hasn't fired yet today.
 * Never looks at yesterday, so a run missed on an earlier day is never owed.
 */
export function lastFireToday(c: Cron, now: number): number | null {
  const d = new Date(now);
  if (!matchesDay(c, d)) return null;
  for (let h = c.hours.length - 1; h >= 0; h--) {
    const hour = c.hours[h]!;
    if (hour > d.getHours()) continue;
    for (let m = c.minutes.length - 1; m >= 0; m--) {
      const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, c.minutes[m]!).getTime();
      if (t <= now) return t;
    }
  }
  return null;
}

/** The first time strictly after `now` that the cron fires, or null if it never does (like `0 0 31 2 *`). */
export function nextFire(c: Cron, now: number): number | null {
  const d = new Date(now);
  // Eight years always contains a Feb 29.
  for (let i = 0; i < 366 * 8; i++) {
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i);
    if (!matchesDay(c, day)) continue;
    for (const hour of c.hours) {
      for (const minute of c.minutes) {
        const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute).getTime();
        if (t > now) return t;
      }
    }
  }
  return null;
}
