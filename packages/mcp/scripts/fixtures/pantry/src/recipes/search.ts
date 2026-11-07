// Pantry is a fictitious app, used to test mapping a codebase into a plan. Not real code.
export interface Recipe {
  id: number;
  title: string;
  ingredients: string[];
}

const recipes: Recipe[] = [
  { id: 1, title: 'Tomato soup', ingredients: ['tomato', 'onion', 'stock'] },
  { id: 2, title: 'Pancakes', ingredients: ['flour', 'egg', 'milk'] },
];

/** Recipes whose title or ingredients mention the words searched for. */
export function searchRecipes(query: string): Recipe[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return recipes.filter((r) => words.every((w) => r.title.toLowerCase().includes(w) || r.ingredients.includes(w)));
}

/** Recipes that can be made from what's in stock. */
export function cookableWith(stock: string[]): Recipe[] {
  return recipes.filter((r) => r.ingredients.every((i) => stock.includes(i)));
}
