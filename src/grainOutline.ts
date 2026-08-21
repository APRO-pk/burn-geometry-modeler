/**
 * Grain cross-section outlines as the web burns back.
 *
 * The solver only ever needs two NUMBERS per web position -- burning area and
 * port area -- so that is all `engine.ts` computes. Drawing the grain needs the
 * SHAPE those numbers came from, which is what this module produces.
 *
 * # Burn-back is polygon offsetting
 *
 * A propellant surface regresses normal to itself at the burn rate, uniformly.
 * That is exactly the definition of an outward polygon offset: the port at web
 * `y` is the initial port grown by `y` in every direction, clipped by the
 * casing. So rather than deriving a bespoke swept shape per geometry, this
 * offsets the initial outline with ClipperLib -- the same library
 * `dxfProcessor.ts` already uses, and the same operation `engine.test.ts`
 * validated the Star burning-area model against.
 *
 * One code path therefore covers all seven geometries, including Custom DXF,
 * whose port is an arbitrary traced profile with no closed form at all.
 *
 * # This is the truth; the solver holds an approximation
 *
 * Offsetting is exact. Several of the solver's analytic area models are not:
 *
 *   - Star, past the point where its flanks vanish, treats the port as a plain
 *     circle. `engine.ts` documents this as up to ~15% low at the transition.
 *   - Finocyl models its fin slots as rectangles, so it keeps sharp interior
 *     corners that a real burn would round off immediately.
 *
 * Where they disagree, the picture drawn here is right and the number the solver
 * reports is approximate. `src/grainOutline.test.ts` measures the gap for every
 * geometry rather than assuming it away, so it is a known quantity instead of a
 * surprise -- and the 3-D view surfaces it live.
 */

import * as ClipperLib from 'clipper-lib';
import type { SurrogateGrain } from './surrogate/features';

export type Pt = { x: number; y: number };

/** ClipperLib is integer-only; this matches the scale dxfProcessor uses. */
const SCALE = 1000000.0;
/** Segments used to approximate a full circle. */
const CIRCLE_SEGMENTS = 160;
/** Arc tolerance for offsetting, in Clipper units (~1 micron). */
const ARC_TOLERANCE = 0.25 * SCALE * 1e-5;

export interface GrainOutline {
  /** Port void boundaries, metres. Empty once the grain is consumed. */
  port: Pt[][];
  /** Solid islands inside the port -- the central rod of a Rod & Tube grain. */
  islands: Pt[][];
  /** Grain length at this web. BATES shortens as its end faces burn. */
  length: number;
  outerRadius: number;
  /** Port area measured from the polygon, m^2. */
  area: number;
  /**
   * Burning perimeter measured from the polygon, m. Excludes boundary that has
   * reached the casing, since propellant no longer exists there to burn.
   */
  perimeter: number;
  burnedOut: boolean;
}

// --- small geometry helpers ------------------------------------------------

function circlePath(cx: number, cy: number, r: number, segments = CIRCLE_SEGMENTS): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (2 * Math.PI * i) / segments;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return out;
}

const toClipper = (p: Pt[]): ClipperLib.Path =>
  p.map((v) => ({ X: Math.round(v.x * SCALE), Y: Math.round(v.y * SCALE) }));
const fromClipper = (p: ClipperLib.Path): Pt[] => p.map((v) => ({ x: v.X / SCALE, y: v.Y / SCALE }));

function polygonArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    a += p[j].x * p[i].y - p[i].x * p[j].y;
  }
  return Math.abs(a) / 2;
}

/**
 * Perimeter of a boundary, skipping any edge lying on the casing wall.
 *
 * Once the port has burned out to the casing, that stretch of boundary is steel,
 * not propellant, and contributes no burning area. Clipper's intersection leaves
 * those casing arcs in the outline, so they have to be excluded here or the
 * reported perimeter keeps growing after the grain has slivered away.
 */
function burningPerimeter(p: Pt[], outerRadius: number): number {
  const rTol = outerRadius * 1e-4;
  let total = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const rj = Math.hypot(p[j].x, p[j].y);
    const ri = Math.hypot(p[i].x, p[i].y);
    if (rj >= outerRadius - rTol && ri >= outerRadius - rTol) continue;
    total += Math.hypot(p[i].x - p[j].x, p[i].y - p[j].y);
  }
  return total;
}

// --- initial outlines ------------------------------------------------------

export interface BaseOutline {
  /** Port void at y = 0. */
  port: Pt[][];
  /** Solid islands within the port at y = 0. */
  islands: Pt[][];
}

/**
 * The port cross-section before any burning.
 *
 * Everything after this is generic offsetting, so this is the only place a
 * geometry's shape is written down.
 */
export function basePortOutline(g: SurrogateGrain): BaseOutline {
  switch (g.kind) {
    case 'BATES':
    case 'Tubular':
      return { port: [circlePath(0, 0, g.inner_radius)], islands: [] };

    case 'MoonBurner':
      // Bore offset from the casing axis, which is what makes it burn
      // progressively on one side and break through on the other.
      return { port: [circlePath(g.offset, 0, g.core_radius)], islands: [] };

    case 'RodAndTube':
      // Annulus: the tube bore is the void, the rod is a solid island inside it.
      return {
        port: [circlePath(0, 0, g.tube_inner_radius)],
        islands: [circlePath(0, 0, g.rod_radius)],
      };

    case 'Star': {
      /*
       * A 2N-gon alternating between two radii. Note the naming in engine.ts is
       * inverted from the intuitive reading: `valley_radius` is the FAR vertex
       * (the star's point) and `tip_radius` the near one (the notch) -- which is
       * why the web is `outer_radius - valley_radius`. Following the field names
       * rather than the words keeps this consistent with the solver.
       */
      const n = Math.max(3, Math.round(g.num_points));
      const theta = Math.PI / n;
      const pts: Pt[] = [];
      for (let i = 0; i < 2 * n; i++) {
        const r = i % 2 === 0 ? g.valley_radius : g.tip_radius;
        const a = i * theta;
        pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
      }
      return { port: [pts], islands: [] };
    }

    case 'Finocyl': {
      // Central bore unioned with radial fin slots.
      const fins = Math.max(1, Math.round(g.num_fins));
      const paths: Pt[][] = [circlePath(0, 0, g.r_tube)];
      const half = g.w_fin / 2;
      const tip = g.r_tube + g.h_fin;
      for (let i = 0; i < fins; i++) {
        const a = (2 * Math.PI * i) / fins;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        // Slot as a rectangle from the bore out to the fin tip, rotated into place.
        const local: Pt[] = [
          { x: 0, y: -half },
          { x: tip, y: -half },
          { x: tip, y: half },
          { x: 0, y: half },
        ];
        paths.push(local.map((p) => ({ x: p.x * ca - p.y * sa, y: p.x * sa + p.y * ca })));
      }
      return { port: unionPaths(paths), islands: [] };
    }

    case 'CustomDXF':
      // The traced profile, retained by dxfProcessor for exactly this purpose.
      return { port: (g.base_polygon ?? []).map((p) => p.slice()), islands: [] };
  }
}

function unionPaths(paths: Pt[][]): Pt[][] {
  if (paths.length <= 1) return paths;
  const c = new ClipperLib.Clipper();
  c.AddPaths(paths.map(toClipper), ClipperLib.PolyType.ptSubject, true);
  const out: ClipperLib.Paths = [];
  c.Execute(
    ClipperLib.ClipType.ctUnion,
    out,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero
  );
  return out.map(fromClipper);
}

function offsetPaths(paths: Pt[][], delta: number): Pt[][] {
  if (!paths.length) return [];
  const co = new ClipperLib.ClipperOffset();
  co.ArcTolerance = ARC_TOLERANCE;
  co.AddPaths(paths.map(toClipper), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const out: ClipperLib.Paths = [];
  co.Execute(out, delta * SCALE);
  return out.map(fromClipper);
}

function clipToCasing(paths: Pt[][], outerRadius: number): Pt[][] {
  if (!paths.length) return [];
  const c = new ClipperLib.Clipper();
  c.AddPaths(paths.map(toClipper), ClipperLib.PolyType.ptSubject, true);
  c.AddPath(toClipper(circlePath(0, 0, outerRadius)), ClipperLib.PolyType.ptClip, true);
  const out: ClipperLib.Paths = [];
  c.Execute(
    ClipperLib.ClipType.ctIntersection,
    out,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero
  );
  return out.map(fromClipper);
}

// --- the outline at a web position ----------------------------------------

/**
 * The grain cross-section after regressing `web` metres.
 *
 * The port grows outward by `web`; solid islands (the Rod & Tube rod) shrink
 * inward by the same amount, since they burn from the outside in.
 */
export function outlineAt(g: SurrogateGrain, web: number): GrainOutline {
  const outerRadius = g.outer_radius;
  const y = Math.max(0, web);
  const base = basePortOutline(g);

  const grown = y > 0 ? offsetPaths(base.port, y) : base.port;
  const port = clipToCasing(grown, outerRadius);

  // Islands recede; a negative offset that consumes them returns nothing.
  const islands = y > 0 ? offsetPaths(base.islands, -y) : base.islands;

  // BATES is the only geometry with burning end faces, so it is the only one
  // that gets shorter as it burns.
  const length = g.kind === 'BATES' ? Math.max(0, g.length - 2 * y) : g.length;

  let area = 0;
  let perimeter = 0;
  for (const p of port) {
    area += polygonArea(p);
    perimeter += burningPerimeter(p, outerRadius);
  }
  for (const p of islands) {
    area -= polygonArea(p);
    perimeter += burningPerimeter(p, outerRadius);
  }

  const casingArea = Math.PI * outerRadius * outerRadius;
  const burnedOut = length <= 0 || area >= casingArea * (1 - 1e-6) || perimeter <= 0;

  return { port, islands, length, outerRadius, area, perimeter, burnedOut };
}
