// Pantry is a fictitious app, used to test mapping a codebase into a plan. Not real code.
import { findItem } from './list.js';

/** Ticks an item off the list once it's bought. */
export function checkOff(id: number): void {
  const item = findItem(id);
  if (!item) throw new Error('No such item');
  item.done = true;
}
