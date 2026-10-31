// When something happened, as short as it can be: just the time today, and more the further back it is.
export function whenText(at: number, now = Date.now(), locale?: string): string {
  const date = new Date(at);
  const today = new Date(now);
  const time: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString(locale, time);
  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleString(locale, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), ...time });
}
