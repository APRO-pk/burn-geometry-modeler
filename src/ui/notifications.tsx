import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Bell, Close, Failure, Info, Ok, Trash, Warning } from './icons';
import './notifications.css';

/**
 * Transient toasts, and a notification centre that keeps the history.
 *
 * WHY BOTH
 *
 * A toast that vanishes is the right way to tell someone a run finished; it is
 * the wrong way to tell them their casing is under-thickness, because they may
 * have been looking at the grain editor when it appeared. Anything worth
 * saying is therefore kept: the toast is the announcement, the centre is the
 * record.
 *
 * This replaces two patterns that were doing the job badly. `alert()` blocked
 * the whole application to report one validation failure at a time, and the
 * autosave recovery banner sat permanently across the top of the chart until
 * dismissed -- both of them interrupting rather than informing.
 *
 * DISMISSAL
 *
 * Timeout scales with severity, because how long a message needs to be readable
 * depends on how much it matters. Anything offering an ACTION never
 * auto-dismisses: a "Restore unsaved design" toast that disappears while the
 * user is reaching for the mouse would be worse than not offering it.
 *
 * Hovering pauses every timer. Reaching for a toast should not be a race.
 */

export type Severity = 'info' | 'success' | 'warning' | 'error';

export interface NotificationAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

export interface NotifyInput {
  title: string;
  /** Optional detail. Kept short: the console has the full text. */
  body?: string;
  severity?: Severity;
  /** Buttons. Any action makes the toast persist until answered. */
  actions?: NotificationAction[];
  /**
   * Group key. A repeat of the same key replaces the previous toast instead of
   * stacking -- otherwise dragging a slider past a limit emits forty identical
   * warnings and buries everything else.
   */
  dedupe?: string;
}

export interface Notification extends NotifyInput {
  id: number;
  severity: Severity;
  at: number;
  /** Set once the toast has left the screen; it stays in the centre. */
  dismissed: boolean;
}

interface Ctx {
  notify: (n: NotifyInput) => number;
  dismiss: (id: number) => void;
  clearHistory: () => void;
  history: Notification[];
  unread: number;
  markAllRead: () => void;
}

const NotificationContext = createContext<Ctx | null>(null);

/** How long a toast stays, by severity. Zero means it waits for the user. */
const TIMEOUT_MS: Record<Severity, number> = {
  success: 4000,
  info: 5000,
  warning: 8000,
  // Long, but still finite: an error the user has already read should not
  // require a click to clear. The centre keeps it either way.
  error: 12000,
};

/** Cap on retained history. Old entries are the least useful and unbounded growth is a leak. */
const HISTORY_LIMIT = 200;

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const [history, setHistory] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setHistory((prev) => prev.map((n) => (n.id === id ? { ...n, dismissed: true } : n)));
  }, []);

  const notify = useCallback((input: NotifyInput) => {
    const id = nextId.current++;
    const n: Notification = {
      severity: 'info',
      ...input,
      id,
      at: Date.now(),
      dismissed: false,
    };
    setHistory((prev) => {
      // A repeat of a deduped message supersedes the live one rather than
      // stacking beside it.
      const cleared = input.dedupe
        ? prev.map((p) => (p.dedupe === input.dedupe && !p.dismissed ? { ...p, dismissed: true } : p))
        : prev;
      return [...cleared, n].slice(-HISTORY_LIMIT);
    });
    setUnread((u) => u + 1);
    return id;
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    setUnread(0);
  }, []);

  const markAllRead = useCallback(() => setUnread(0), []);

  const value = useMemo(
    () => ({ notify, dismiss, clearHistory, history, unread, markAllRead }),
    [notify, dismiss, clearHistory, history, unread, markAllRead]
  );

  return (
    <NotificationContext.Provider value={value}>
      {children}
      <ToastStack />
    </NotificationContext.Provider>
  );
}

export function useNotifications(): Ctx {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error('useNotifications must be used inside a NotificationProvider');
  }
  return ctx;
}

/* -------------------------------------------------------------- icons */

function SeverityIcon({ severity, size = 13 }: { severity: Severity; size?: number }) {
  const common = { size, 'aria-hidden': true } as const;
  switch (severity) {
    case 'success':
      return <Ok {...common} />;
    case 'warning':
      return <Warning {...common} />;
    case 'error':
      return <Failure {...common} />;
    default:
      return <Info {...common} />;
  }
}

/* --------------------------------------------------------- ToastStack */

function ToastStack() {
  const { history, dismiss } = useNotifications();
  const live = history.filter((n) => !n.dismissed);
  const [paused, setPaused] = useState(false);

  if (!live.length) return null;

  return (
    <div className="nt-stack">
      {/*
        * Two live regions, because urgency differs. Errors interrupt a screen
        * reader; a "simulation finished" does not deserve to.
        */}
      <div className="nt-sr" role="status" aria-live="polite" />
      <div className="nt-sr" role="alert" aria-live="assertive" />
      {live.slice(-4).map((n) => (
        <Toast key={n.id} n={n} paused={paused} onPause={setPaused} onDismiss={dismiss} />
      ))}
    </div>
  );
}

function Toast({
  n,
  paused,
  onPause,
  onDismiss,
}: {
  n: Notification;
  paused: boolean;
  onPause: (p: boolean) => void;
  /** Stable across renders, so the countdown effect is not torn down needlessly. */
  onDismiss: (id: number) => void;
}) {
  // Anything asking a question waits for its answer.
  const sticky = !!n.actions?.length;
  const total = TIMEOUT_MS[n.severity];

  /*
   * One timer for the whole life of the toast, not a chain of ticks.
   *
   * The first version decremented a counter every 100ms through React state:
   * ten re-renders a second per toast, and -- worse -- the elapsed time drifted
   * badly under load, because each tick waits AT LEAST 100ms and then queues a
   * render. A "4 second" toast measurably outlived its welcome on a busy
   * machine, which is exactly when the user least wants it there.
   *
   * Now a single timeout owns dismissal, and `remaining` is tracked only to
   * survive pausing. The progress bar is a CSS animation, so it costs nothing
   * and stays in step with real time.
   */
  const remaining = useRef(total);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    if (sticky || paused) return;

    startedAt.current = Date.now();
    const t = setTimeout(() => onDismiss(n.id), remaining.current);

    /*
     * Bank the elapsed time on EVERY teardown, not just when pausing.
     *
     * This effect re-runs whenever its dependencies change, which includes any
     * re-render that gives `onDismiss` a new identity. Restarting the timeout
     * from the full duration each time meant an unrelated notification arriving
     * silently extended every toast already on screen -- measured at 4989ms for
     * a 4000ms toast when a second one appeared beside it.
     */
    return () => {
      clearTimeout(t);
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
    };
  }, [paused, sticky, onDismiss, n.id]);

  return (
    <div
      className={`nt-toast is-${n.severity}`}
      role={n.severity === 'error' ? 'alert' : 'status'}
      /*
       * Pausing lives on the toast rather than the stack, because the toast
       * already carries a role and the stack is a bare container -- putting
       * interaction on the container would mean inventing a role for it.
       *
       * Hovering or focusing ANY toast pauses them all: they overlap in one
       * corner, so a user reaching for the third should not lose the first.
       * Focus matters more than hover here -- tabbing to a Restore button only
       * to have it vanish mid-reach is worse than never offering the action.
       */
      onMouseEnter={() => onPause(true)}
      onMouseLeave={() => onPause(false)}
      onFocusCapture={() => onPause(true)}
      onBlurCapture={() => onPause(false)}
    >
      <span className="nt-toast-icon">
        <SeverityIcon severity={n.severity} />
      </span>
      <div className="nt-toast-text">
        <div className="nt-toast-title">{n.title}</div>
        {n.body && <div className="nt-toast-body">{n.body}</div>}
        {n.actions && (
          <div className="nt-toast-actions">
            {n.actions.map((a) => (
              <button
                key={a.label}
                type="button"
                className={`nt-action ${a.primary ? 'is-primary' : ''}`}
                onClick={() => {
                  a.onClick();
                  onDismiss(n.id);
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        className="nt-toast-close"
        onClick={() => onDismiss(n.id)}
        aria-label="Dismiss"
      >
        <Close size={12} />
      </button>
      {/*
        * A visible countdown, so a toast vanishing is never a surprise.
        * Animated by CSS rather than React, so it neither re-renders nor drifts.
        */}
      {!sticky && (
        <div
          className="nt-toast-timer"
          style={{
            animationDuration: `${total}ms`,
            animationPlayState: paused ? 'paused' : 'running',
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------ NotificationBell */

/**
 * The bell, and the centre it opens.
 *
 * Lives in the toolbar. The badge counts what has arrived since the panel was
 * last opened, so it answers "is there anything new" rather than "how many
 * things have ever happened".
 */
export function NotificationBell() {
  const { history, unread, markAllRead, clearHistory } = useNotifications();
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

  const toggle = () => {
    setOpen((v) => {
      if (!v) markAllRead();
      return !v;
    });
  };

  const newest = [...history].reverse();

  return (
    <div className="nt-bell-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`nt-bell ${open ? 'is-open' : ''}`}
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={
          unread > 0 ? `Notifications, ${unread} unread` : 'Notifications, none unread'
        }
        title="Notifications"
      >
        <Bell size={13} />
        {unread > 0 && <span className="nt-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>

      {open && (
        <div className="nt-panel" role="dialog" aria-label="Notification history">
          <div className="nt-panel-head">
            <span>Notifications</span>
            <button
              type="button"
              className="nt-panel-clear"
              onClick={clearHistory}
              disabled={!history.length}
              title="Clear all"
            >
              <Trash size={11} /> Clear
            </button>
          </div>
          <div className="nt-panel-body">
            {newest.length === 0 ? (
              <p className="nt-empty">Nothing yet.</p>
            ) : (
              newest.map((n) => (
                <div key={n.id} className={`nt-item is-${n.severity}`}>
                  <span className="nt-item-icon">
                    <SeverityIcon severity={n.severity} size={12} />
                  </span>
                  <div className="nt-item-text">
                    <div className="nt-item-title">{n.title}</div>
                    {n.body && <div className="nt-item-body">{n.body}</div>}
                  </div>
                  <time className="nt-item-time" dateTime={new Date(n.at).toISOString()}>
                    {new Date(n.at).toLocaleTimeString()}
                  </time>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
