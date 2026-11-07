// Pantry is a fictitious app, used to test mapping a codebase into a plan. Not real code.
export interface StockItem {
  name: string;
  expiresOn: Date | null;
}

const stock: StockItem[] = [];

/** Records food put away in the pantry. */
export function addToStock(name: string, expiresOn: Date | null): void {
  stock.push({ name, expiresOn });
}

/** Removes food that was used up. */
export function useUp(name: string): void {
  const i = stock.findIndex((s) => s.name === name);
  if (i >= 0) stock.splice(i, 1);
}

export function inStock(): StockItem[] {
  return [...stock];
}
