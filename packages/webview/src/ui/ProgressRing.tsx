import type { Progress } from '@idea-to-code/core';

/** A small ring: the done fraction in the status green, the rest as a faint track. */
export function ProgressRing({ progress, size = 16 }: { progress: Progress; size?: number }) {
  const stroke = 2.25;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const fraction = progress.total ? progress.done / progress.total : 0;
  const complete = progress.total > 0 && progress.done === progress.total;
  return (
    <svg
      className={`ring${complete ? ' ring--complete' : ''}`}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
    >
      <circle className="ring__track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
      {fraction > 0 && (
        <circle
          className="ring__value"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${c * fraction} ${c}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
    </svg>
  );
}

export function progressText(p: Progress): string {
  if (!p.total) return 'No steps yet';
  if (p.done === p.total) return `All ${p.total} done`;
  return `${p.done} of ${p.total} done`;
}
