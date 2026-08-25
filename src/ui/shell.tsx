import React, { useEffect, useRef, useState } from 'react';
import './shell.css';

/**
 * Window furniture: menu bar, toolbar, resizable docks, status strip.
 *
 * These are what make an interface read as an application rather than a web
 * page, and they are the parts the previous UI faked with div soup -- a "menu"
 * that was a row of buttons with no keyboard handling, docks of fixed width, a
 * tab strip with no roles.
 */

/* ---------------------------------------------------------------- MenuBar */

export interface MenuItem {
  label: string;
  onSelect?: () => void;
  /** Shown right-aligned, e.g. "Ctrl+R". Display only; bind the key yourself. */
  accel?: string;
  disabled?: boolean;
  /** A rule between groups of items. */
  separatorBefore?: boolean;
}

export interface Menu {
  label: string;
  items: MenuItem[];
}

/**
 * A real menu bar.
 *
 * Behaves the way desktop menus do, because half-implemented menus are worse
 * than none: click to open, then hovering another top-level menu switches to it
 * without a second click; Escape closes; arrow keys move between menus; a click
 * anywhere else dismisses. Each menu is a button, so keyboard users reach them
 * by tabbing and open with Enter.
 */
export function MenuBar({ menus }: { menus: Menu[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open === null) return;
    const onDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="sh-menubar" ref={barRef} role="menubar">
      {menus.map((m, i) => (
        <div key={m.label} className="sh-menu">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === i}
            className={`sh-menu-btn ${open === i ? 'is-open' : ''}`}
            onClick={() => setOpen(open === i ? null : i)}
            // Once one menu is open, sliding across the bar switches menus --
            // the behaviour every desktop menu bar has.
            onMouseEnter={() => open !== null && setOpen(i)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') setOpen((i + 1) % menus.length);
              if (e.key === 'ArrowLeft') setOpen((i - 1 + menus.length) % menus.length);
            }}
          >
            {m.label}
          </button>
          {open === i && (
            <div className="sh-menu-pop" role="menu" aria-label={m.label}>
              {m.items.map((item) => (
                <React.Fragment key={item.label}>
                  {item.separatorBefore && <div className="sh-menu-sep" role="separator" />}
                  <button
                    type="button"
                    role="menuitem"
                    className="sh-menu-item"
                    disabled={item.disabled}
                    onClick={() => {
                      setOpen(null);
                      item.onSelect?.();
                    }}
                  >
                    <span>{item.label}</span>
                    {item.accel && <span className="sh-menu-accel">{item.accel}</span>}
                  </button>
                </React.Fragment>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- Toolbar */

export function Toolbar({ children }: { children: React.ReactNode }) {
  return (
    <div className="sh-toolbar" role="toolbar">
      {children}
    </div>
  );
}

export function ToolbarSep() {
  return <div className="sh-toolbar-sep" role="separator" aria-orientation="vertical" />;
}

export function ToolbarSpacer() {
  return <div className="sh-toolbar-spacer" />;
}

/* ------------------------------------------------------------------- Dock */

export interface DockProps {
  side: 'left' | 'right';
  width: number;
  onWidthChange: (w: number) => void;
  min?: number;
  max?: number;
  children: React.ReactNode;
  label: string;
}

/**
 * A resizable side dock.
 *
 * The splitter is a real control, not a decorative line: it is focusable and
 * responds to arrow keys, because a mouse-only resize handle is unusable to
 * anyone who cannot use a mouse, and this dock holds forty parameters that a
 * user may well want more room for.
 */
export function Dock({
  side,
  width,
  onWidthChange,
  min = 200,
  max = 560,
  children,
  label,
}: DockProps) {
  const dragging = useRef(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const w = side === 'left' ? e.clientX : window.innerWidth - e.clientX;
      onWidthChange(Math.max(min, Math.min(max, w)));
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [side, min, max, onWidthChange]);

  const splitter = (
    <div
      className="sh-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onMouseDown={() => {
        dragging.current = true;
        document.body.style.cursor = 'col-resize';
      }}
      onKeyDown={(e) => {
        const d = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
        if (!d) return;
        e.preventDefault();
        const dir = side === 'left' ? 1 : -1;
        onWidthChange(Math.max(min, Math.min(max, width + d * dir)));
      }}
    />
  );

  return (
    <>
      {side === 'right' && splitter}
      <aside className="sh-dock" style={{ width }} aria-label={label}>
        {children}
      </aside>
      {side === 'left' && splitter}
    </>
  );
}

/* -------------------------------------------------------------- TabStrip */

export interface TabDef {
  id: string;
  label: string;
  /** A count or state marker rendered after the label. */
  badge?: React.ReactNode;
}

/**
 * Document-style tabs with roving tabindex and arrow-key navigation.
 *
 * Same behaviour as the previous ARIA tablist, kept because it was correct;
 * only the appearance changed.
 */
export function TabStrip({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: readonly TabDef[];
  active: string;
  onChange: (id: string) => void;
  label: string;
}) {
  return (
    <div
      className="sh-tabs"
      role="tablist"
      aria-label={label}
      onKeyDown={(e) => {
        const ids = tabs.map((t) => t.id);
        const cur = ids.indexOf(active);
        let next = -1;
        if (e.key === 'ArrowRight') next = (cur + 1) % ids.length;
        else if (e.key === 'ArrowLeft') next = (cur - 1 + ids.length) % ids.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = ids.length - 1;
        if (next < 0) return;
        e.preventDefault();
        onChange(ids[next]);
        document.getElementById(`tab-${ids[next]}`)?.focus();
      }}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          id={`tab-${t.id}`}
          role="tab"
          type="button"
          aria-selected={active === t.id}
          aria-controls="tab-panel"
          tabIndex={active === t.id ? 0 : -1}
          className={`sh-tab ${active === t.id ? 'is-active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          <span>{t.label}</span>
          {t.badge}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- StatusBar */

export function StatusBar({ children }: { children: React.ReactNode }) {
  return (
    <footer className="sh-status" role="status">
      {children}
    </footer>
  );
}
