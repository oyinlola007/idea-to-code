import type { Status } from '@idea-to-code/core';

const STATUS_TEXT: Record<Status, string> = { todo: 'To do', in_progress: 'In progress', done: 'Done' };

export function statusText(status: Status): string {
  return STATUS_TEXT[status];
}
