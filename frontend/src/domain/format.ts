import type { Cell } from '../types';

// Display formatting only. Times are shown in the shop's time zone (EAT,
// UTC+3) as in the design; the sheet stores UTC ISO strings.

const TIME_ZONE = 'Africa/Addis_Ababa';

const dateFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, day: 'numeric', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false });

export const isBlank = (value: Cell | undefined | null): boolean => value === undefined || value === null || value === '';

export function formatDateTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${dateFmt.format(d)}, ${timeFmt.format(d)} EAT`;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : timeFmt.format(d);
}

/** Effective dates are calendar dates (YYYY-MM-DD) with no time zone. */
export function formatDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(d);
}

const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A price cell (a number of ETB) as 1,520.00; blank stays blank. */
export function formatPrice(value: Cell): string {
  if (isBlank(value)) return '';
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? money.format(n) : String(value);
}

/** A change_pct cell (already rounded by the core) as +40.0%. */
export function formatPct(value: Cell): string {
  if (isBlank(value)) return '';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}%`;
}

export function minutesBetween(fromIso: string, toIso: string): number {
  return Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / 60000);
}

export const cellText = (value: Cell): string => (isBlank(value) ? '' : String(value));
