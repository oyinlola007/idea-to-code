// Pantry is a fictitious app, used to test mapping a codebase into a plan. Not real code.
const saved = new Map<number, Set<number>>();

/** Keeps a recipe in the user's saved list. */
export function saveRecipe(userId: number, recipeId: number): void {
  const list = saved.get(userId) ?? new Set<number>();
  list.add(recipeId);
  saved.set(userId, list);
}

export function savedRecipes(userId: number): number[] {
  return [...(saved.get(userId) ?? [])];
}
