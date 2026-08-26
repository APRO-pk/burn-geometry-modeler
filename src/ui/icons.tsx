import React from 'react';

/**
 * The application's marks, drawn here rather than pulled from an icon library.
 *
 * WHY NOT A LIBRARY
 *
 * Library sets are drawn for consumer software: rounded caps, soft joins, a
 * friendly weight. Dropped into a dense engineering tool at 11px they read as
 * decoration, and they are the single strongest signal that an interface came
 * from a template. This app draws pressure traces and wall stresses; its marks
 * should look like they came from the same drafting board.
 *
 * SO THESE ARE
 *
 * Geometric, single-weight, square-capped, monochrome. Every one is built from
 * straight lines and right angles on a 16-unit grid, inherits `currentColor`,
 * and carries no fill. Nothing here is a mascot: there is no sparkle, no
 * checkmark-in-a-circle, no gradient.
 *
 * They are deliberately plain. An icon in this interface is a signpost next to
 * a word, never a substitute for one.
 */

export interface IconProps {
  size?: number;
  className?: string;
}

/** Shared frame. Square caps and a constant stroke keep the set coherent. */
function Svg({
  size = 12,
  className,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="square"
      strokeLinejoin="miter"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/* ---- disclosure ---- */

export const ChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3l5 5-5 5" />
  </Svg>
);
export const ChevronLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 3L5 8l5 5" />
  </Svg>
);
export const ChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 6l5 5 5-5" />
  </Svg>
);
export const ChevronUp = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 10l5-5 5 5" />
  </Svg>
);

/* ---- actions ---- */

/** Run. A plain triangle, not a rounded media button. */
export const Play = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 2.5l9 5.5-9 5.5z" />
  </Svg>
);
export const Pause = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 3v10M11 3v10" />
  </Svg>
);
export const Close = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
  </Svg>
);
export const Plus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);
export const Trash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 4h10M6.5 4V2.5h3V4M4.5 4l.5 9.5h6L11.5 4" />
  </Svg>
);
export const Download = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2v8M4.5 7L8 10.5 11.5 7M3 13.5h10" />
  </Svg>
);
export const Upload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 10.5v-8M4.5 5.5L8 2l3.5 3.5M3 13.5h10" />
  </Svg>
);

/** Undo and redo. An arrow returning over an arc, squared off. */
export const Undo = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 4.5H3.5V2M3.5 4.5A5.5 5.5 0 1 1 3.5 9" />
  </Svg>
);
export const Redo = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 4.5h2.5V2M12.5 4.5A5.5 5.5 0 1 0 12.5 9" />
  </Svg>
);
export const Reset = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8a5 5 0 1 1 1.6 3.7M3 4.5V8h3.5" />
  </Svg>
);

/* ---- status ---- */

/**
 * Warning. A triangle with a bar, not the rounded library glyph.
 *
 * Severity is carried by colour and by the word beside it; the shape only has
 * to be distinguishable at a glance from the error mark.
 */
export const Warning = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2l6 11H2z" />
    <path d="M8 6.5v3" />
  </Svg>
);

/**
 * Failure. A square with a cross: squarer than the warning triangle.
 *
 * Named Failure, not Error: an icon called `Error` shadows the global
 * constructor, and `new Error(...)` in the same module then tries to construct
 * a React component. That is a genuinely confusing five minutes.
 */
export const Failure = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 2.5h11v11h-11z" />
    <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" />
  </Svg>
);

/**
 * Success. A filled square, not a checkmark.
 *
 * A tick is the most template-looking mark in interface design, and it says
 * "done" where this app usually means "within tolerance". A solid block in the
 * success colour reads as a state, which is what it is.
 */
export const Ok = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 3.5h9v9h-9z" fill="currentColor" stroke="none" />
  </Svg>
);

/** Information. A bar and a dot in a square. */
export const Info = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 2.5h11v11h-11z" />
    <path d="M8 7v4" />
    <path d="M8 4.6v.9" />
  </Svg>
);

/** Notifications. A plain bell outline, squared at the base. */
export const Bell = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 11.5V7a4 4 0 0 1 8 0v4.5M2.5 11.5h11M6.5 13.5h3" />
  </Svg>
);

/* ---- objects ---- */

/** Console. A prompt caret and a line. */
export const Terminal = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 4l3 4-3 4M8.5 12h4.5" />
  </Svg>
);

/** Settings. Three horizontal sliders, which is what the panel actually is. */
export const Settings = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    <path d="M6 3v3M11 6.5v3M5 10v3" />
  </Svg>
);

/** Geometry. A cross-section: a square with a bore. */
export const Grain = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 2.5h11v11h-11z" />
    <path d="M6 6h4v4H6z" />
  </Svg>
);

/** Parameter sweep. A rising step, not a lightning bolt. */
export const Sweep = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 12.5V3M2.5 12.5h11" />
    <path d="M4.5 10.5h2v-3h2v-3h2" />
  </Svg>
);
