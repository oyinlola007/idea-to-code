// Pure helpers for the chat page: grouping items into turns, adding streamed text,
// and splitting a reply into paragraphs and lists without ever parsing it as HTML.
import type { ChatItem, ChatView } from '@idea-to-code/core';

export interface Turn {
  /** The message that started it; absent for anything before the first message. */
  user?: Extract<ChatItem, { kind: 'user' }>;
  items: Exclude<ChatItem, { kind: 'user' }>[];
}

export function groupTurns(items: readonly ChatItem[]): Turn[] {
  const turns: Turn[] = [];
  for (const item of items) {
    if (item.kind === 'user') turns.push({ user: item, items: [] });
    else {
      const last = turns.at(-1);
      if (last) last.items.push(item);
      else turns.push({ items: [item] });
    }
  }
  return turns;
}

/** The view with streamed text added to one assistant item. Unknown items are left alone. */
export function appendText(view: ChatView, itemId: string, text: string): ChatView {
  const index = view.items.findIndex((item) => item.kind === 'assistant' && item.id === itemId);
  const target = view.items[index];
  if (target?.kind !== 'assistant') return view;
  const items = [...view.items];
  items[index] = { ...target, text: target.text + text };
  return { ...view, items };
}

export type Block = { kind: 'paragraph'; text: string } | { kind: 'list'; items: string[] };

/** Blank lines separate paragraphs; lines starting with "- " or "* " form a list. */
export function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  for (const chunk of text.split(/\n\s*\n/)) {
    const lines = chunk.split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) continue;
    if (lines.every((line) => /^\s*[-*] /.test(line))) {
      blocks.push({ kind: 'list', items: lines.map((line) => line.replace(/^\s*[-*] /, '')) });
    } else {
      blocks.push({ kind: 'paragraph', text: lines.join('\n') });
    }
  }
  return blocks;
}
