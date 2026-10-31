// Which levels of the path to tuck behind "…". Pure, so the rule is tested without a browser.

/**
 * How many levels to hide, counting from the one after the main map. The main map
 * and the current level always stay, and the levels nearest you stay longest.
 * Widths are one per level, each including its separator.
 */
export function crumbsToHide(widths: readonly number[], available: number, moreWidth: number): number {
  const total = widths.reduce((sum, width) => sum + width, 0);
  if (total <= available) return 0;
  const most = Math.max(widths.length - 2, 0);
  let kept = total + moreWidth;
  for (let hidden = 1; hidden <= most; hidden++) {
    kept -= widths[hidden] ?? 0;
    if (kept <= available) return hidden;
  }
  return most;
}
