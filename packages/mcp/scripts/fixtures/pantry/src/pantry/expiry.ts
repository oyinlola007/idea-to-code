// Pantry is a fictitious app, used to test mapping a codebase into a plan. Not real code.
import { inStock, type StockItem } from './stock.js';

const DAY = 24 * 60 * 60 * 1000;

/** Food that expires within the next few days, soonest first. */
export function expiringSoon(today: Date, days = 3): StockItem[] {
  return inStock()
    .filter((s) => s.expiresOn !== null && s.expiresOn.getTime() - today.getTime() <= days * DAY)
    .sort((a, b) => (a.expiresOn?.getTime() ?? 0) - (b.expiresOn?.getTime() ?? 0));
}
