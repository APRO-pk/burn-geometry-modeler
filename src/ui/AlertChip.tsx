import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, XCircle } from 'lucide-react';
import './alertchip.css';

/**
 * A compact count in the toolbar that opens the detail on click.
 *
 * WHY NOT A BANNER
 *
 * Stability warnings used to render as a full-width panel above the tab
 * content, pushing the chart down every time a design ran hot. That is the
 * wrong trade: the warning is two lines of text that you read once, and it was
 * costing a permanent stripe of the most valuable space in the window on every
 * run of a marginal design.
 *
 * WHY NOT ONLY A TOAST
 *
 * A toast announces; it does not persist. The warning stays TRUE after the
 * toast fades -- the motor is still over-pressured -- so something durable has
 * to remain, or the only record is a console line that has scrolled away.
 *
 * So: the toast announces it once, and this chip stays for as long as the
 * condition holds. Hovering gives the gist, clicking gives the full list.
 */

export interface AlertChipProps {
  severity: 'warning' | 'error';
  /** Shown next to the count, e.g. "warning". Pluralised automatically. */
  noun: string;
  items: string[];
  /** Heading for the popover. */
  title: string;
  /** Optional footer, e.g. a link to the console. */
  footer?: React.ReactNode;
}

export function AlertChip({ severity, noun, items, title, footer }: AlertChipProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!items.length) return null;

  const Icon = severity === 'error' ? XCircle : AlertTriangle;
  const label = `${items.length} ${noun}${items.length > 1 ? 's' : ''}`;

  return (
    <div className="ac-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`ac-chip is-${severity} ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        /*
         * The full text in the tooltip as well as the popover: hovering should
         * answer the question without a click when there is only one item, and
         * a native title is the one tooltip that works for keyboard focus and
         * screen readers without extra machinery.
         */
        title={`${title}\n\n${items.map((i) => `• ${i}`).join('\n')}`}
      >
        <Icon size={12} aria-hidden="true" />
        <span>{label}</span>
      </button>

      {open && (
        <div className={`ac-pop is-${severity}`} role="dialog" aria-label={title}>
          <div className="ac-pop-head">{title}</div>
          <ul className="ac-pop-list">
            {items.map((it, i) => (
              <li key={i}>{it}</li>
            ))}
          </ul>
          {footer && <div className="ac-pop-foot">{footer}</div>}
        </div>
      )}
    </div>
  );
}

export default AlertChip;
