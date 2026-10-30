// Recognises a project after its folder moves. Feature and node IDs never
// change, so the set of IDs identifies a plan even after it has been edited.
import { allIds, loadFromTexts, MAIN, OVERVIEW } from '@idea-to-code/core';

export function planFingerprint(texts: Readonly<Record<string, string>>): string[] {
  const ids = allIds(loadFromTexts(texts));
  ids.delete(MAIN);
  ids.delete(OVERVIEW);
  return [...ids].sort();
}

/** Shared IDs as a share of all IDs (Jaccard), from 0 to 1. */
export function similarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const left = new Set(a);
  const shared = b.filter((id) => left.has(id)).length;
  return shared / (left.size + b.length - shared);
}
