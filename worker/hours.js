/* ==========================================================================
   Tacos De Princesa — worker/hours.js
   Opening hours, the online-ordering window, pickup times and holidays.
   KEEP IN SYNC with section "0b. Hours, pickup and holidays" in js/order.js
   (same values, same results): scripts/check-menu.mjs runs both and fails
   if they differ.

   - Stores: Mon-Fri 10:30-18:00.
   - Online orders: from opening until 17:30 (orderUntilBeforeClose); from
     17:31:00 on, refused.
   - Pickup: the same day only. ASAP (about 20 minutes), or any 15-minute
     slot from 20 minutes from now up to 17:45 (lastSlotBeforeClose).
   - Closed all day on these holidays, worked out for any year (no list to
     update): New Year's Day, Family Day, Good Friday, Victoria Day, Canada
     Day, Civic Holiday, Labour Day, Thanksgiving, Christmas Day, Boxing Day.
     One that falls on a weekend closes the next free weekday instead
     (Christmas on Saturday -> Monday, Boxing Day on Sunday -> Tuesday).
   - CLOSED_DATES (a Worker setting) adds one-off closures.
   ========================================================================== */

// days: 0 = Sunday ... 6 = Saturday
export const HOURS = {
  'king-st-w': { days: [1, 2, 3, 4, 5], open: '10:30', close: '18:00' },
  'one-york': { days: [1, 2, 3, 4, 5], open: '10:30', close: '18:00' },
};

export const PICKUP = {
  timeZone: 'America/Toronto',
  slotMinutes: 15,           // pickup slots every 15 minutes
  kitchenLeadMinutes: 20,    // ASAP is about this long; the first slot is at least this far away
  orderUntilBeforeClose: 30, // online orders until closing minus this (17:30)
  lastSlotBeforeClose: 15,   // last pickup slot = closing minus this (17:45)
};

const DAY = 86400000;

export function toMinutes(hhmm) {
  const parts = hhmm.split(':');
  return Number(parts[0]) * 60 + Number(parts[1]);
}

// 1050 -> '5:30 pm'
export function clockText(minutes) {
  const h = Math.floor(minutes / 60);
  return ((h + 11) % 12 + 1) + ':' + String(minutes % 60).padStart(2, '0') + (h < 12 ? ' am' : ' pm');
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Easter Sunday (Gregorian calendar), as a UTC midnight timestamp
function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(year, month - 1, day);
}

// The nth weekday (0 = Sunday) of a month (1-12)
function nthWeekday(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return Date.UTC(year, month - 1, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
}

// The weekdays a year's holidays close the stores: [{ iso, name }], by date
export function holidayClosures(year) {
  let victoria = Date.UTC(year, 4, 24); // the Monday before May 25
  while (new Date(victoria).getUTCDay() !== 1) victoria -= DAY;
  const holidays = [
    ['New Year’s Day', Date.UTC(year, 0, 1)],
    ['Family Day', nthWeekday(year, 2, 1, 3)],
    ['Good Friday', easterSunday(year) - 2 * DAY],
    ['Victoria Day', victoria],
    ['Canada Day', Date.UTC(year, 6, 1)],
    ['Civic Holiday', nthWeekday(year, 8, 1, 1)],
    ['Labour Day', nthWeekday(year, 9, 1, 1)],
    ['Thanksgiving', nthWeekday(year, 10, 1, 2)],
    ['Christmas Day', Date.UTC(year, 11, 25)],
    ['Boxing Day', Date.UTC(year, 11, 26)],
  ];
  const taken = {};
  return holidays.map(function (holiday) {
    let day = holiday[1];
    // On a weekend, or a day another holiday already closes: the next weekday
    while ([0, 6].indexOf(new Date(day).getUTCDay()) !== -1 || taken[day]) day += DAY;
    taken[day] = true;
    return { iso: isoDate(day), name: holiday[0] };
  });
}

const holidayCache = {}; // year -> holidayClosures(year)

// Why a date (YYYY-MM-DD) is closed: the holiday's name, 'closed' for a
// CLOSED_DATES day, or null when it isn't
export function closureOn(iso, closedDates) {
  const year = +iso.slice(0, 4);
  const closures = holidayCache[year] || (holidayCache[year] = holidayClosures(year));
  const holiday = closures.filter(function (h) { return h.iso === iso; })[0];
  if (holiday) return holiday.name;
  return (closedDates || []).indexOf(iso) !== -1 ? 'closed' : null;
}

// Toronto's date and time now: { iso, weekday, minutes }
export function torontoNow(now) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: PICKUP.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).forEach(function (part) { p[part.type] = part.value; });
  return {
    iso: p.year + '-' + p.month + '-' + p.day,
    weekday: new Date(Date.UTC(+p.year, +p.month - 1, +p.day)).getUTCDay(),
    minutes: +p.hour * 60 + +p.minute,
  };
}

// Can a store take an online order at this moment? -> { ok: true } or
// { ok: false, reason: 'holiday' | 'closed' | 'before' | 'after', holiday? }
export function orderingWindow(hours, now, closedDates) {
  const closure = closureOn(now.iso, closedDates);
  if (closure && closure !== 'closed') return { ok: false, reason: 'holiday', holiday: closure };
  if (closure || hours.days.indexOf(now.weekday) === -1) return { ok: false, reason: 'closed' };
  if (now.minutes < toMinutes(hours.open)) return { ok: false, reason: 'before' };
  if (now.minutes > toMinutes(hours.close) - PICKUP.orderUntilBeforeClose) return { ok: false, reason: 'after' };
  return { ok: true };
}

// Today's pickup slots (minutes after midnight) when ordering at this
// minute: every 15 minutes from 20 minutes from now up to the last slot
export function pickupSlots(hours, nowMinutes) {
  const step = PICKUP.slotMinutes;
  const last = toMinutes(hours.close) - PICKUP.lastSlotBeforeClose;
  const slots = [];
  for (let t = Math.ceil((nowMinutes + PICKUP.kitchenLeadMinutes) / step) * step; t <= last; t += step) slots.push(t);
  return slots;
}
