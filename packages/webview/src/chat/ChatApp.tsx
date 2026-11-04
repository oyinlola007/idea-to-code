// The chat in the idea-to-code sidebar: your messages, the agent's replies, and one
// line when the plan changed. Everything else (which model, each tool call) stays out
// of sight. The page only draws; the conversation and the agent live in the host.
import type { ChartSettings, ChatAction, ChatItem, ChatView, ModelSettingsView, ModelTestResult, SettingsTab } from '@idea-to-code/core';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { onHostMessage, send } from '../bridge.js';
import { Settings } from './Settings.js';
import { appendText, blocksOf, groupTurns, type Turn } from './turns.js';

function Icon({ name, className }: { name: string; className?: string }) {
  return <span className={`codicon codicon-${name}${className ? ` ${className}` : ''}`} aria-hidden="true" />;
}

function Reply({ text }: { text: string }) {
  return (
    <div className="chat__reply">
      {blocksOf(text).map((block, i) =>
        block.kind === 'list' ? (
          <ul key={i}>
            {block.items.map((item, j) => (
              <li key={j}>{item}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>{block.text}</p>
        ),
      )}
    </div>
  );
}

function Changed({ item }: { item: Extract<ChatItem, { kind: 'changes' }> }) {
  const label = item.undone === true ? 'Undone' : item.cancelled === true ? 'Stopped, changes kept' : 'Plan updated';
  const { reveal } = item;
  return (
    <div className="chat__changed" title={item.summary}>
      <span className={`chat__dot${item.undone === true ? ' chat__dot--off' : ''}`} aria-hidden="true" />
      {reveal ? (
        <button
          type="button"
          className="chat__show"
          onClick={() => {
            send({ type: 'chat-show-changes', reveal });
          }}
        >
          {label}
        </button>
      ) : (
        <span>{label}</span>
      )}
      {item.undoable === true && (
        <button
          type="button"
          className="chat__link"
          onClick={() => {
            send({ type: 'chat-action', action: 'undo' });
          }}
        >
          Undo
        </button>
      )}
    </div>
  );
}

/** A notice that offers a fix is just the fix; the button says what's missing. */
function Notice({ item, onSettings }: { item: Extract<ChatItem, { kind: 'notice' }>; onSettings: () => void }) {
  if (item.action === 'open-model-settings') {
    return (
      <div className="chat__notice" role="alert" title={item.text}>
        <button type="button" className="chat__button chat__button--wide" onClick={onSettings}>
          Choose a model
        </button>
      </div>
    );
  }
  return (
    <p className={`chat__notice chat__notice--${item.tone}`} role={item.tone === 'error' ? 'alert' : undefined}>
      {item.text}
    </p>
  );
}

/** While the agent works: what it's doing right now, in one line. */
function Working({ turn }: { turn: Turn }) {
  const latest = turn.items.findLast((item) => item.kind === 'activity');
  return (
    <div className="chat__working">
      <Icon name="loading" className="codicon-modifier-spin" />
      <span>{latest?.kind === 'activity' ? latest.text : 'Thinking…'}</span>
    </div>
  );
}

function TurnView({ turn, working, onSettings }: { turn: Turn; working: boolean; onSettings: () => void }) {
  return (
    <article className="chat__turn">
      {turn.user && <div className="chat__ask">{turn.user.text}</div>}
      {turn.items.map((item) => {
        if (item.kind === 'assistant') return item.text === '' ? null : <Reply key={item.id} text={item.text} />;
        if (item.kind === 'changes') return <Changed key={item.id} item={item} />;
        if (item.kind === 'notice') return <Notice key={item.id} item={item} onSettings={onSettings} />;
        return null;
      })}
      {working && <Working turn={turn} />}
    </article>
  );
}

function Composer({ busy, first }: { busy: boolean; first: boolean }) {
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${String(Math.min(el.scrollHeight, 200))}px`;
  }, [text]);

  const submit = () => {
    const message = text.trim();
    if (message === '' || busy) return;
    send({ type: 'chat-send', text: message });
    setText('');
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="chat__composer">
      <div className="chat__input">
        <textarea
          ref={box}
          rows={1}
          value={text}
          placeholder={first ? 'What are you building?' : 'Ask or describe a change'}
          aria-label="Message"
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={onKey}
        />
        {busy ? (
          <button
            type="button"
            className="chat__send"
            aria-label="Stop"
            title="Stop"
            onClick={() => {
              send({ type: 'chat-cancel' });
            }}
          >
            <Icon name="debug-stop" />
          </button>
        ) : (
          <button type="button" className="chat__send" aria-label="Send" title="Send" disabled={text.trim() === ''} onClick={submit}>
            <Icon name="arrow-up" />
          </button>
        )}
      </div>
    </div>
  );
}

/** What stands in the way of chatting, and the one button that fixes it. Each shows where the first message would. */
const FIXES: Record<Exclude<ChatView['status'], 'ready'>, { label: string; action: ChatAction | 'settings' }> = {
  'no-folder': { label: 'Open a folder', action: 'open-folder' },
  untrusted: { label: 'Trust this folder', action: 'trust' },
  'no-plan': { label: 'Start a plan', action: 'init-plan' },
  'no-model': { label: 'Choose a model', action: 'settings' },
};

export function ChatApp() {
  const [view, setView] = useState<ChatView | null>(null);
  const [settings, setSettings] = useState<SettingsTab | null>(null);
  const [models, setModels] = useState<ModelSettingsView | null>(null);
  const [test, setTest] = useState<ModelTestResult[] | 'running' | null>(null);
  const [chart, setChart] = useState<ChartSettings | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const stop = onHostMessage((message) => {
      if (message.type === 'chat') setView(message.view);
      else if (message.type === 'chat-text') setView((current) => (current ? appendText(current, message.itemId, message.text) : current));
      else if (message.type === 'show-settings') setSettings(message.tab ?? 'models');
      else if (message.type === 'model-settings') {
        setModels(message.view);
        // A result says nothing about settings that have since changed.
        setTest((current) => (current === 'running' ? current : null));
      } else if (message.type === 'model-test-result') setTest(message.results);
      else if (message.type === 'chart-settings') setChart(message.view);
    });
    send({ type: 'ready' });
    return stop;
  }, []);

  // The title follows what's shown, and each tab asks for what it shows.
  useEffect(() => {
    send({ type: 'settings-shown', shown: settings !== null });
    if (settings === 'models') send({ type: 'model-settings-get' });
    if (settings === 'chart') send({ type: 'chart-settings-get' });
  }, [settings]);

  // Follows new text, unless the reader has scrolled up to look at something.
  useLayoutEffect(() => {
    const el = list.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [view]);

  if (!view) return <div className="chat" aria-busy="true" />;
  if (settings !== null) {
    return (
      <div className="chat">
        <Settings
          tab={settings}
          onTab={setSettings}
          onBack={() => {
            setSettings(null);
          }}
          trusted={view.status !== 'untrusted'}
          models={models}
          test={test}
          onTest={() => {
            setTest('running');
            send({ type: 'model-test' });
          }}
          chart={chart}
        />
      </div>
    );
  }
  // A chat already under way stays readable; sending then says what's missing, in place.
  if (view.status !== 'ready' && !(view.status === 'no-model' && view.items.length > 0)) {
    const fix = FIXES[view.status];
    return (
      <div className="chat">
        <div className="chat__fix">
          <button
            type="button"
            className="chat__button chat__button--wide"
            onClick={() => {
              if (fix.action === 'settings') setSettings('models');
              else send({ type: 'chat-action', action: fix.action });
            }}
          >
            {fix.label}
          </button>
        </div>
      </div>
    );
  }
  const turns = groupTurns(view.items);
  return (
    <div className="chat">
      <div
        ref={list}
        className="chat__list"
        aria-live="polite"
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {turns.map((turn, i) => (
          <TurnView
            key={turn.user?.id ?? i}
            turn={turn}
            working={view.busy && i === turns.length - 1}
            onSettings={() => {
              setSettings('models');
            }}
          />
        ))}
      </div>
      <Composer busy={view.busy} first={turns.length === 0} />
    </div>
  );
}
