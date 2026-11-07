// Pantry is a fictitious app, used to test mapping a codebase into a plan. Not real code.
export interface Item {
  id: number;
  name: string;
  done: boolean;
}

const items: Item[] = [];

/** Adds an item to the shopping list, once. */
export function addItem(name: string): Item {
  const existing = items.find((i) => i.name === name && !i.done);
  if (existing) return existing;
  const item = { id: items.length + 1, name, done: false };
  items.push(item);
  return item;
}

/** Adds every ingredient of a recipe that isn't in stock. */
export function addMissing(ingredients: string[], stock: string[]): Item[] {
  return ingredients.filter((i) => !stock.includes(i)).map(addItem);
}

export function listItems(): Item[] {
  return items.filter((i) => !i.done);
}

export function findItem(id: number): Item | undefined {
  return items.find((i) => i.id === id);
}
