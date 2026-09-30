import React, { useId, useState } from 'react';
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
