// Changes to the plan from outside this editor, such as Claude Code or another agent
// working through the MCP server. Agents save one change per tool call, so a burst
// is pointed out once it pauses, as one change from where it started.
import { loadFromTexts, revealChanges, type Reveal } from '@idea-to-code/core';

type Texts = Record<string, string>;

/** Long enough to group an agent's quick calls, short enough to follow it while it works. */
export const OUTSIDE_QUIET_MS = 2500;

function same(a: Texts, b: Texts): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

export class OutsideEdits {
  private last: Texts | undefined;
  /** The plan before the burst under way. */
  private start: Texts | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly onReveal: (reveal: Reveal) => void,
    private readonly quietMs = OUTSIDE_QUIET_MS,
  ) {}

  /** The plan on disk now. `own` changes (the chart, Undo, the built-in agent, a save in this editor) are never pointed out. */
  seen(texts: Texts, own: boolean): void {
    if (this.last === undefined) {
      this.last = texts;
      return;
    }
    if (same(texts, this.last)) return;
    if (own) {
      this.cancel();
    } else {
      this.start ??= this.last;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.flush();
      }, this.quietMs);
    }
    this.last = texts;
  }

  /** Another plan, or none: start again. */
  reset(): void {
    this.cancel();
    this.last = undefined;
  }

  private flush(): void {
    const { start, last } = this;
    this.start = undefined;
    if (!start || !last) return;
    const reveal = revealChanges(loadFromTexts(start), loadFromTexts(last));
    if (reveal) this.onReveal(reveal);
  }

  private cancel(): void {
    clearTimeout(this.timer);
    this.start = undefined;
  }

  dispose(): void {
    this.cancel();
  }
}
