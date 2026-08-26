import React, { useId, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from './icons';
import './primitives.css';

/**
 * The widget vocabulary the desktop UI is built from.
 *
 * Every one of these existed before as inline Tailwind repeated across a
 * 3,000-line component -- forty variations of "a label next to a number box",
 * each with its own padding and border colour. Naming them makes the interface
 * consistent by construction rather than by vigilance, and puts the
 * accessibility work (label association, focus, keyboard handling) in one place
 * instead of forty.
 */

/* ------------------------------------------------------------------ Panel */

export interface PanelProps {
  title?: string;
  /** Right-aligned content in the title bar: counts, small toggles. */
  actions?: React.ReactNode;
  children: React.ReactNode;
  /** Collapsible panels remember nothing; the caller owns the state if it matters. */
  collapsible?: boolean;
  defaultOpen?: boolean;
  className?: string;
  /** Removes body padding, for panels holding a canvas or table edge-to-edge. */
  flush?: boolean;
}

export function Panel({
  title,
  actions,
  children,
  collapsible = false,
  defaultOpen = true,
  className = '',
  flush = false,
}: PanelProps) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const showBody = !collapsible || open;

  return (
    <section className={`ui-panel ${className}`}>
      {title !== undefined && (
        <header className="ui-panel-head">
          {collapsible ? (
            <button
              type="button"
              className="ui-panel-title ui-panel-toggle"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-controls={bodyId}
            >
              {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              <span>{title}</span>
            </button>
          ) : (
            <div className="ui-panel-title">{title}</div>
          )}
          {actions && <div className="ui-panel-actions">{actions}</div>}
        </header>
      )}
      {showBody && (
        <div id={bodyId} className={`ui-panel-body ${flush ? 'is-flush' : ''}`}>
          {children}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ Field */

export interface FieldIssue {
  severity: 'error' | 'warning';
  message: string;
}

export interface FieldProps {
  label: string;
  /** Rendered to the right of the control: a unit, or a unit picker. */
  suffix?: React.ReactNode;
  issues?: FieldIssue[];
  children: (id: string, describedBy: string | undefined) => React.ReactNode;
  /** Explanation shown on hover, for a parameter whose name is not enough. */
  hint?: string;
}

/**
 * One labelled row: label, control, unit, and any validation beneath.
 *
 * The label is associated with the control by construction -- the child is a
 * function receiving the id -- so it is not possible to add a field here and
 * forget it, which is exactly how 34 unassociated labels accumulated before.
 */
export function Field({ label, suffix, issues = [], children, hint }: FieldProps) {
  const id = useId();
  const msgId = `${id}-msg`;
  const worst = issues.some((i) => i.severity === 'error')
    ? 'error'
    : issues.length
      ? 'warning'
      : null;

  return (
    <div className={`ui-field ${worst ? `is-${worst}` : ''}`}>
      <label className="ui-field-label" htmlFor={id} title={hint}>
        {label}
      </label>
      <div className="ui-field-control">
        {children(id, issues.length ? msgId : undefined)}
        {suffix && <div className="ui-field-suffix">{suffix}</div>}
      </div>
      {issues.length > 0 && (
        <div id={msgId} className="ui-field-msgs">
          {issues.map((i, k) => (
            <p
              key={k}
              className={`ui-field-msg is-${i.severity}`}
              role={i.severity === 'error' ? 'alert' : undefined}
            >
              {i.message}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- NumberInput */

export interface NumberInputProps {
  id: string;
  value: number | string;
  onChange: (v: number) => void;
  step?: number | string;
  describedBy?: string;
  invalid?: boolean;
  /** Increment on arrow keys and wheel, if different from `step`. */
  nudge?: number;
}

/**
 * A numeric entry that behaves the way a desktop spin box does.
 *
 * Two behaviours worth stating. It keeps what you typed while you are typing:
 * "1e" and "-" and "0." are all legal intermediate states, and coercing them to
 * 0 on each keystroke (as the previous input did) made it impossible to type an
 * exponent. And arrow keys step the value, which is how anyone used to a native
 * tool expects to nudge a dimension.
 */
export function NumberInput({
  id,
  value,
  onChange,
  step = 'any',
  describedBy,
  invalid,
  nudge,
}: NumberInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  const shown = draft ?? String(value);

  const commit = (raw: string) => {
    const n = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(n)) onChange(n);
  };

  const stepBy = (dir: number, coarse: boolean) => {
    const base = Number(shown);
    if (!Number.isFinite(base)) return;
    const inc = nudge ?? (typeof step === 'number' ? step : magnitudeStep(base));
    const next = base + dir * inc * (coarse ? 10 : 1);
    setDraft(null);
    onChange(next);
  };

  return (
    <input
      ref={ref}
      id={id}
      type="text"
      inputMode="decimal"
      className="ui-input ui-input-num"
      value={shown}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(e) => {
        setDraft(e.target.value);
        commit(e.target.value);
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          stepBy(1, e.shiftKey);
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          stepBy(-1, e.shiftKey);
        } else if (e.key === 'Enter') {
          setDraft(null);
        }
      }}
    />
  );
}

/**
 * A sensible step for a value of this size.
 *
 * A fixed step is wrong across the range this app spans: the same control holds
 * a 0.0003 burn coefficient and a 3000 K flame temperature, and stepping either
 * by 1 is useless. One part in a hundred of the current magnitude behaves for
 * both.
 */
function magnitudeStep(v: number): number {
  const m = Math.abs(v);
  if (m === 0) return 0.01;
  return Math.pow(10, Math.floor(Math.log10(m)) - 2);
}

/* ----------------------------------------------------------------- Select */

export interface SelectProps<T extends string> {
  id?: string;
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
  describedBy?: string;
  'aria-label'?: string;
  className?: string;
}

export function Select<T extends string>({
  id,
  value,
  onChange,
  options,
  describedBy,
  className = '',
  ...rest
}: SelectProps<T>) {
  return (
    <select
      id={id}
      className={`ui-input ui-select ${className}`}
      value={value}
      aria-describedby={describedBy}
      aria-label={rest['aria-label']}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/* ----------------------------------------------------------------- Button */

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  icon?: React.ReactNode;
}

export function Button({
  variant = 'default',
  icon,
  children,
  className = '',
  ...rest
}: ButtonProps) {
  return (
    <button type="button" className={`ui-btn is-${variant} ${className}`} {...rest}>
      {icon}
      {children && <span>{children}</span>}
    </button>
  );
}

/* -------------------------------------------------------------- Checkbox */

export interface CheckboxProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: React.ReactNode;
  /** A colour swatch, for chart series toggles. */
  swatch?: string;
  disabled?: boolean;
}

export function Checkbox({ checked, onChange, label, swatch, disabled }: CheckboxProps) {
  return (
    <label className={`ui-check ${disabled ? 'is-disabled' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {swatch && <span className="ui-check-swatch" style={{ background: swatch }} />}
      <span className="ui-check-label">{label}</span>
    </label>
  );
}

/* -------------------------------------------------------------- Statistic */

export interface StatProps {
  label: string;
  value: React.ReactNode;
  /** Uncertainty band, shown beside the value. This app's distinguishing feature. */
  band?: string;
  tone?: 'default' | 'ok' | 'warn' | 'danger';
  hint?: string;
}

/**
 * One readout in the statistics strip.
 *
 * The band is the point. Every other tool of this kind prints peak pressure to
 * four figures and stops; this one can say how many of those figures mean
 * anything, so the band sits next to the number rather than in a panel the user
 * has to go and find.
 */
export function Stat({ label, value, band, tone = 'default', hint }: StatProps) {
  return (
    <div className={`ui-stat is-${tone}`} title={hint}>
      <div className="ui-stat-label">{label}</div>
      <div className="ui-stat-value selectable">
        {value}
        {band && <span className="ui-stat-band">{band}</span>}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- Sections */

/** A labelled group of fields inside a dock. */
export function FieldGroup({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="ui-group">
      <button
        type="button"
        className="ui-group-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={id}
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <span>{title}</span>
      </button>
      {open && (
        <div id={id} className="ui-group-body">
          {children}
        </div>
      )}
    </div>
  );
}
