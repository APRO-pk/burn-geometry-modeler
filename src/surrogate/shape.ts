/**
 * What a legal grain shape is, expressed once.
 *
 * Both the sampler (tools/sample.mts) and the inverse-design search
 * (./optimize.ts) need to produce grains. Last time those were written
 * separately the search happily returned a 57 mm throat inside a 46 mm bore --
 * a shape the sampler would have rejected outright, so the model had never seen
 * anything like it and was free to invent whatever the objective wanted there.
 *
 * The fix is not more validation on the search's output; it is for both to
 * build grains through the same function. `grainFromShape` is that function.
 *
 * # Fractions, not absolute dimensions
 *
 * Shape is parameterised as fractions -- bore as a fraction of the casing, fin
 * height as a fraction of the remaining web -- rather than as radii in metres.
 * Two reasons. Proportions stay sane at every motor size, instead of only at the
 * large end where a fixed 10 mm bore is reasonable. And validity is automatic:
 * a fraction in [0,1] cannot put the bore outside the casing however the other
 * parameters move, so an optimiser can walk the space freely without generating
 * impossible geometry at every step.
 */

import type { GrainKind, SurrogateGrain } from './features';

export interface ShapeParam {
  /** Identifier used in the search and in diagnostics. */
  name: string;
  /** Human label for the UI. */
  label: string;
  /** Allowed range for the fraction. */
  bounds: [number, number];
  /** True if the value must be a whole number (point counts, fin counts). */
  integer?: boolean;
}

/**
 * The shape degrees of freedom per geometry, in the order `grainFromShape`
 * consumes them.
 *
 * Custom DXF has none: its cross-section comes from a traced file, and there is
 * no meaningful way to "optimise" a shape the user supplied as data. Inverse
 * design over a DXF grain therefore moves only length, throat and expansion --
 * which is the honest scope rather than a limitation to apologise for.
 */
export const GRAIN_SHAPE_PARAMS: Record<GrainKind, ShapeParam[]> = {
  BATES: [{ name: 'boreFrac', label: 'Bore / casing radius', bounds: [0.2, 0.7] }],
  Tubular: [{ name: 'boreFrac', label: 'Bore / casing radius', bounds: [0.2, 0.7] }],
  Star: [
    { name: 'valleyFrac', label: 'Valley / casing radius', bounds: [0.35, 0.75] },
    { name: 'tipFrac', label: 'Tip / valley radius', bounds: [0.2, 0.7] },
    { name: 'points', label: 'Star points', bounds: [3, 12], integer: true },
  ],
  RodAndTube: [
    // Down to 0.3, not 0.45: the app ships a default at 0.4, and a sampled range
    // that excludes the shipped default leaves the model extrapolating the
    // moment a user opens the tab.
    { name: 'tubeFrac', label: 'Tube bore / casing radius', bounds: [0.3, 0.85] },
    { name: 'rodFrac', label: 'Rod / tube bore radius', bounds: [0.15, 0.6] },
  ],
  MoonBurner: [
    { name: 'coreFrac', label: 'Core / casing radius', bounds: [0.15, 0.5] },
    { name: 'offsetFrac', label: 'Offset / available room', bounds: [0.05, 0.95] },
  ],
  Finocyl: [
    { name: 'tubeFrac', label: 'Bore / casing radius', bounds: [0.15, 0.5] },
    { name: 'fins', label: 'Fin count', bounds: [3, 10], integer: true },
    /*
     * Fin height runs PAST the web (fraction > 1) on purpose.
     *
     * Above 1 the fin tips start beyond the casing, so the slots are against the
     * wall from ignition and the grain begins in the Finocyl model's second
     * phase. That is not a degenerate case to be excluded -- it is what the app
     * ships as its default (35 mm fins in a 30 mm web), and capping the range at
     * 0.85 left the model extrapolating on the very first Finocyl a user sees.
     */
    { name: 'finFrac', label: 'Fin height / web', bounds: [0.2, 1.4] },
  ],
  CustomDXF: [],
};

/**
 * Build a grain from its shape fractions.
 *
 * Returns null when the combination is geometrically impossible. Most
 * combinations are made possible by construction (see the header), but a few
 * interactions still have to be checked -- notably that a Finocyl's fin tips and
 * a MoonBurner's offset bore stay inside the casing.
 */
export function grainFromShape(
  kind: GrainKind,
  length: number,
  outerRadius: number,
  shape: number[],
  dxf?: { dx: number; perim_table: number[]; area_table: number[] }
): SurrogateGrain | null {
  if (!(length > 0) || !(outerRadius > 0)) return null;

  switch (kind) {
    case 'BATES': {
      const bore = outerRadius * shape[0];
      if (!(bore > 0 && bore < outerRadius)) return null;
      return { kind, length, outer_radius: outerRadius, inner_radius: bore };
    }
    case 'Tubular': {
      const bore = outerRadius * shape[0];
      if (!(bore > 0 && bore < outerRadius)) return null;
      return { kind, length, outer_radius: outerRadius, inner_radius: bore };
    }
    case 'Star': {
      const valley = outerRadius * shape[0];
      const tip = valley * shape[1];
      const points = Math.max(3, Math.round(shape[2]));
      if (!(tip > 0 && tip < valley && valley < outerRadius)) return null;
      return {
        kind,
        length,
        outer_radius: outerRadius,
        valley_radius: valley,
        tip_radius: tip,
        num_points: points,
      };
    }
    case 'RodAndTube': {
      const tubeInner = outerRadius * shape[0];
      const rod = tubeInner * shape[1];
      if (!(rod > 0 && rod < tubeInner && tubeInner < outerRadius)) return null;
      return {
        kind,
        length,
        outer_radius: outerRadius,
        rod_radius: rod,
        tube_inner_radius: tubeInner,
      };
    }
    case 'MoonBurner': {
      const core = outerRadius * shape[0];
      // Offset is a fraction of the room left between the core and the casing,
      // so the bore cannot be pushed outside however `coreFrac` moves.
      const room = Math.max(outerRadius - core, 0) * 0.9;
      const offset = room * shape[1];
      if (!(core > 0 && offset >= 0 && core + offset < outerRadius)) return null;
      return { kind, length, outer_radius: outerRadius, core_radius: core, offset };
    }
    case 'Finocyl': {
      const rTube = outerRadius * shape[0];
      const fins = Math.max(3, Math.round(shape[1]));
      const hFin = (outerRadius - rTube) * shape[2];
      // Slot width narrow enough that N slots cannot consume the whole bore
      // circumference, which would drive the burning perimeter negative.
      const wFin = Math.min((2 * Math.PI * rTube) / (fins * 3), rTube * 0.6);
      // Fin tips are allowed past the casing (see finFrac above); what must hold
      // is that the BORE is inside it, which is what leaves web left to burn.
      if (!(rTube > 0 && hFin > 0 && wFin > 0 && rTube < outerRadius)) return null;
      return {
        kind,
        length,
        outer_radius: outerRadius,
        r_tube: rTube,
        num_fins: fins,
        w_fin: wFin,
        h_fin: hFin,
      };
    }
    case 'CustomDXF': {
      if (!dxf) return null;
      return {
        kind,
        length,
        outer_radius: outerRadius,
        dx: dxf.dx,
        perim_table: dxf.perim_table,
        area_table: dxf.area_table,
      };
    }
  }
}

/**
 * Recover shape fractions from an existing grain, so the search can start from
 * the design the user is already looking at rather than somewhere random.
 */
export function shapeFromGrain(g: SurrogateGrain): number[] {
  const R = g.outer_radius;
  switch (g.kind) {
    case 'BATES':
    case 'Tubular':
      return [g.inner_radius / R];
    case 'Star':
      return [g.valley_radius / R, g.tip_radius / Math.max(g.valley_radius, 1e-9), g.num_points];
    case 'RodAndTube':
      return [
        g.tube_inner_radius / R,
        g.rod_radius / Math.max(g.tube_inner_radius, 1e-9),
        ];
    case 'MoonBurner': {
      const room = Math.max(R - g.core_radius, 1e-9) * 0.9;
      return [g.core_radius / R, g.offset / room];
    }
    case 'Finocyl':
      return [
        g.r_tube / R,
        g.num_fins,
        g.h_fin / Math.max(R - g.r_tube, 1e-9),
      ];
    case 'CustomDXF':
      return [];
  }
}

/** The DXF tables from a grain, for rebuilding it during a search. */
export function dxfTablesOf(g: SurrogateGrain) {
  return g.kind === 'CustomDXF'
    ? { dx: g.dx, perim_table: g.perim_table, area_table: g.area_table }
    : undefined;
}
