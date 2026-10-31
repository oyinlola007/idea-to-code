// A one-line text entry: Enter saves, Esc cancels, and its keys stay out of the
// chart's shortcuts while it has focus.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

interface Props {
  label: string;
  initial?: string;
  placeholder?: string;
  className?: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}

export function TextForm({ label, initial = '', placeholder, className = '', onSave, onCancel }: Props) {
  const [text, setText] = useState(initial);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const trimmed = text.trim();
      if (trimmed !== '' && trimmed !== initial) onSave(trimmed);
      else onCancel();
    }
  };

  return (
    <input
      ref={input}
      type="text"
      className={`text-form ${className}`}
      aria-label={label}
      placeholder={placeholder}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
      }}
      onKeyDown={onKeyDown}
      onBlur={onCancel}
    />
  );
}
