import React, { Component } from 'react';
import { Warning } from './ui/icons';

/**
 * Catches a render error in one part of the UI instead of losing the whole app.
 *
 * React unmounts the entire tree when a render throws and nothing catches it.
 * With no boundary anywhere, a single bad value reaching one chart -- a NaN
 * axis domain, an undefined field on a results row -- blanked the screen and
 * took the user's unsaved design with it. That is a bad trade for a tool where
 * the design in the editor may represent an afternoon of work.
 *
 * Boundaries are placed per tab and around each chart, so a failure costs the
 * user that panel and nothing else.
 *
 * Note what this cannot do: it only catches errors thrown during RENDER,
 * lifecycle, and constructors. Errors inside event handlers and async callbacks
 * are not caught, because React has no way to know which part of the tree they
 * belong to. Those still need their own try/catch.
 */

interface Props {
  children: React.ReactNode;
  /** Shown in the fallback, so the user knows what they lost. */
  label: string;
  /** Reported alongside the error, when the host provides a log. */
  onError?: (message: string) => void;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Keep the stack in the console for anyone with devtools open, and put a
    // one-line version in the app's own log where a user will actually see it.
    console.error(`[${this.props.label}] render failed`, error, info.componentStack);
    this.props.onError?.(`${this.props.label} failed to render: ${error.message}`);
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        className="border border-[var(--sem-danger)] bg-[var(--sem-danger-wash)] p-4 m-2 text-xs"
      >
        <div className="flex items-center gap-2 text-[var(--sem-danger)] font-bold mb-2">
          <Warning size={14} aria-hidden="true" />
          <span>{this.props.label} failed to render</span>
        </div>
        <p className="text-[var(--sem-danger)] leading-snug mb-3">
          The rest of the app is unaffected and your design is intact. This panel
          hit an error while drawing.
        </p>
        <pre className="text-[10px] text-[var(--sem-danger)] whitespace-pre-wrap break-words mb-3">
          {error.message}
        </pre>
        <button
          type="button"
          onClick={this.reset}
          className="border border-[var(--sem-danger)] text-[var(--sem-danger)] px-3 py-1 hover:bg-[var(--sem-danger-wash)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--sem-danger)]"
        >
          Try again
        </button>
      </div>
    );
  }
}

export default ErrorBoundary;
