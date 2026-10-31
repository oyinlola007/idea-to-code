// Real text widths in the webview, using the editor's own font.
import type { Measure } from './metrics.js';

const FONTS = {
  title: { weight: 600, size: 14, mono: false },
  label: { weight: 500, size: 13, mono: false },
  body: { weight: 400, size: 12, mono: false },
  meta: { weight: 500, size: 11, mono: false },
  mono: { weight: 400, size: 11, mono: true },
} as const;

export function canvasMeasure(): Measure {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) throw new Error('no 2d canvas');
  const css = getComputedStyle(document.documentElement);
  const ui = css.getPropertyValue('--vscode-font-family').trim() || 'system-ui, sans-serif';
  const mono = css.getPropertyValue('--vscode-editor-font-family').trim() || 'ui-monospace, monospace';
  const cache = new Map<string, number>();
  return (text, font) => {
    const key = `${font}\u0000${text}`;
    let w = cache.get(key);
    if (w === undefined) {
      const f = FONTS[font];
      ctx.font = `${f.weight} ${f.size}px ${f.mono ? mono : ui}`;
      w = ctx.measureText(text).width;
      cache.set(key, w);
    }
    return w;
  };
}
