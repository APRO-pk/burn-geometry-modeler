import { describe, it, expect } from 'vitest';
import { outlineAt } from './grainOutline';
import { grainFromConfig, burnoutWeb } from './surrogate/features';
import type { SurrogateGrain } from './surrogate/features';

/*
 * ============================================================================
 * The drawn grain against the solved grain
 * ============================================================================
 *
 * src/grainOutline.ts regresses the port by offsetting its polygon, which is
 * what burn-back physically IS. src/engine.ts computes the same quantities
 * analytically, because the solver needs numbers rather than shapes.
 *
 * Two independent routes to the same physics, so they can be checked against
 * each other -- and where they disagree, the disagreement is worth knowing
 * rather than hiding, because the solver's models are documented approximations
 * for two of the seven geometries:
 *
 *   Star, past the web where its flanks vanish, is modelled as a plain circle.
 *   Finocyl models fin slots as sharp rectangles, which a real burn rounds off.
 *
 * So these tests assert agreement tightly where the solver is exact, and
 * MEASURE the gap where it is not. A test that demanded equality everywhere
 * would have to be loosened to the worst case and would then catch nothing.
 * ============================================================================
 */

const LEN = 0.3;

const EXACT: Array<{ name: string; grain: SurrogateGrain; tol: number }> = [
  {
    name: 'BATES',
    grain: { kind: 'BATES', length: LEN, outer_radius: 0.05, inner_radius: 0.02 },
    tol: 2e-3,
  },
  {
    name: 'Tubular',
    grain: { kind: 'Tubular', length: LEN, outer_radius: 0.05, inner_radius: 0.02 },
    tol: 2e-3,
  },
  {
    name: 'MoonBurner',
    grain: {
      kind: 'MoonBurner',
      length: LEN,
      outer_radius: 0.05,
      core_radius: 0.015,
      offset: 0.012,
    },
    tol: 5e-3,
  },
  {
    name: 'RodAndTube',
    grain: {
      kind: 'RodAndTube',
      length: LEN,
      outer_radius: 0.05,
      rod_radius: 0.01,
      tube_inner_radius: 0.03,
    },
    tol: 5e-3,
  },
];

/** Geometries whose analytic model is a documented approximation. */
const APPROXIMATE: Array<{ name: string; grain: SurrogateGrain }> = [
  {
    name: 'Star',
    grain: {
      kind: 'Star',
      length: LEN,
      outer_radius: 0.05,
      valley_radius: 0.03,
      tip_radius: 0.01,
      num_points: 5,
    },
  },
  {
    name: 'Finocyl',
    grain: {
      kind: 'Finocyl',
      length: LEN,
      outer_radius: 0.05,
      r_tube: 0.015,
      num_fins: 6,
      w_fin: 0.005,
      h_fin: 0.018,
    },
  },
];

const ALL = [...EXACT.map((c) => c.grain), ...APPROXIMATE.map((c) => c.grain)];

// =========================================================================
describe('initial outline reproduces the initial port area', () => {
  for (const g of ALL) {
    it(`${g.kind}: polygon area at y=0 matches get_port_area(0)`, () => {
      const analytic = grainFromConfig(g).get_port_area(0);
      const drawn = outlineAt(g, 0).area;
      const rel = Math.abs(drawn - analytic) / analytic;
      expect(rel, `${g.kind}: drawn ${drawn} vs analytic ${analytic}`).toBeLessThan(5e-3);
    });
  }

  it('Star starts as the exact star polygon, N*Rv*Rt*sin(pi/N)', () => {
    // The closed form engine.test.ts pins. If the drawn polygon reproduces it,
    // the vertex ordering and the valley/tip naming are both right -- and that
    // naming is inverted from the intuitive reading.
    const g = APPROXIMATE[0].grain as Extract<SurrogateGrain, { kind: 'Star' }>;
    const expected =
      g.num_points * g.valley_radius * g.tip_radius * Math.sin(Math.PI / g.num_points);
    // 1e-4, not machine precision: ClipperLib works in integers, so vertices
    // are quantised to the SCALE grid (1 micron here). Sub-micron is far below
    // anything that matters for either drawing or area bookkeeping.
    expect(Math.abs(outlineAt(g, 0).area - expected) / expected).toBeLessThan(1e-4);
  });

  it('Rod & Tube starts as an annulus, not a disc', () => {
    const g = EXACT[3].grain as Extract<SurrogateGrain, { kind: 'RodAndTube' }>;
    const o = outlineAt(g, 0);
    expect(o.islands.length).toBe(1);
    const expected = Math.PI * (g.tube_inner_radius ** 2 - g.rod_radius ** 2);
    expect(Math.abs(o.area - expected) / expected).toBeLessThan(5e-3);
  });
});

// =========================================================================
describe('offsetting matches the solver where the solver is exact', () => {
  for (const { name, grain, tol } of EXACT) {
    it(`${name}: port area tracks get_port_area(y) across the burn`, () => {
      const g = grainFromConfig(grain);
      const web = burnoutWeb(g);
      let worst = 0;
      for (const f of [0.1, 0.25, 0.5, 0.75, 0.9]) {
        const y = f * web;
        const analytic = g.get_port_area(y);
        const drawn = outlineAt(grain, y).area;
        if (analytic > 0) worst = Math.max(worst, Math.abs(drawn - analytic) / analytic);
      }
      expect(worst, `${name}: worst relative port-area error ${worst}`).toBeLessThan(tol);
    });

    it(`${name}: burning perimeter tracks the lateral burning area`, () => {
      const g = grainFromConfig(grain);
      const web = burnoutWeb(g);
      let worst = 0;
      for (const f of [0.1, 0.25, 0.5, 0.75]) {
        const y = f * web;
        const o = outlineAt(grain, y);
        // BATES is the only geometry with burning end faces; its lateral area
        // is what a cross-section perimeter can represent.
        const endArea =
          grain.kind === 'BATES'
            ? 2 * Math.PI * (grain.outer_radius ** 2 - (grain.inner_radius + y) ** 2)
            : 0;
        const lateral = g.get_burning_area(y) - endArea;
        const drawn = o.perimeter * o.length;
        if (lateral > 0) worst = Math.max(worst, Math.abs(drawn - lateral) / lateral);
      }
      expect(worst, `${name}: worst relative perimeter error ${worst}`).toBeLessThan(tol * 3);
    });
  }
});

// =========================================================================
describe('where the solver approximates, the gap is measured not assumed', () => {
  for (const { name, grain } of APPROXIMATE) {
    it(`${name}: reports how far the analytic model sits from true offsetting`, () => {
      const g = grainFromConfig(grain);
      const web = burnoutWeb(g);
      const rows: string[] = [];
      let worstArea = 0;
      let worstPerim = 0;

      for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const y = f * web;
        const o = outlineAt(grain, y);
        const aA = g.get_port_area(y);
        const aP = g.get_burning_area(y) / grain.length;
        const dArea = aA > 0 ? (o.area - aA) / aA : 0;
        const dPerim = aP > 0 ? (o.perimeter - aP) / aP : 0;
        // The last sample is printed but not bounded. Approaching burnout both
        // routes are describing a vanishing sliver, so a RELATIVE difference
        // between them says nothing about either -- the Finocyl model clamps
        // its perimeter at zero there and reads 80% apart on a quantity that is
        // itself heading to zero.
        if (f <= 0.7) {
          worstArea = Math.max(worstArea, Math.abs(dArea));
          worstPerim = Math.max(worstPerim, Math.abs(dPerim));
        }
        rows.push(
          `      y/web ${f.toFixed(1)}  area ${(dArea * 100).toFixed(2).padStart(7)}%` +
            `  perimeter ${(dPerim * 100).toFixed(2).padStart(7)}%`
        );
      }
      console.log(`\n    ${name} -- true offsetting vs the solver's analytic model:`);
      rows.forEach((r) => console.log(r));

      // Loose bounds: these exist to catch a gross regression in either route,
      // not to pin the approximation error, which is a property of the model.
      expect(worstArea, `${name} area gap`).toBeLessThan(0.6);
      expect(worstPerim, `${name} perimeter gap`).toBeLessThan(0.6);
    });
  }
});

// =========================================================================
describe('burn-back invariants', () => {
  for (const g of ALL) {
    it(`${g.kind}: port area grows monotonically and never exceeds the casing`, () => {
      const web = burnoutWeb(grainFromConfig(g));
      const casing = Math.PI * g.outer_radius ** 2;
      let prev = -Infinity;
      for (let f = 0; f <= 1.0001; f += 0.1) {
        const o = outlineAt(g, f * web);
        expect(o.area, `${g.kind} at f=${f.toFixed(1)}`).toBeGreaterThanOrEqual(prev - 1e-9);
        expect(o.area).toBeLessThanOrEqual(casing * (1 + 1e-6));
        prev = o.area;
      }
    });

    it(`${g.kind}: produces drawable geometry throughout the burn`, () => {
      const web = burnoutWeb(grainFromConfig(g));
      for (let f = 0; f < 1; f += 0.125) {
        const o = outlineAt(g, f * web);
        expect(o.port.length, `${g.kind} at f=${f}`).toBeGreaterThan(0);
        for (const ring of o.port) {
          expect(ring.length).toBeGreaterThan(2);
          for (const p of ring) {
            expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
            expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(g.outer_radius * 1.001);
          }
        }
      }
    });
  }

  it('BATES shortens as its end faces burn; the others do not', () => {
    const bates = EXACT[0].grain;
    const web = burnoutWeb(grainFromConfig(bates));
    expect(outlineAt(bates, 0.5 * web).length).toBeCloseTo(LEN - web, 6);

    for (const g of ALL.filter((x) => x.kind !== 'BATES')) {
      expect(outlineAt(g, 0.5 * burnoutWeb(grainFromConfig(g))).length, g.kind).toBe(LEN);
    }
  });

  it("Rod & Tube's central rod shrinks away and then is gone", () => {
    const g = EXACT[3].grain as Extract<SurrogateGrain, { kind: 'RodAndTube' }>;
    expect(outlineAt(g, 0).islands.length).toBe(1);
    const half = outlineAt(g, g.rod_radius * 0.5);
    expect(half.islands.length).toBe(1);
    // Past its own radius the rod cannot survive a negative offset.
    expect(outlineAt(g, g.rod_radius * 1.2).islands.length).toBe(0);
  });

  it('MoonBurner breaks through the casing on its offset side', () => {
    // The characteristic behaviour: an off-axis bore reaches one wall long
    // before the other, so the port stops being a closed circle.
    const g = EXACT[2].grain as Extract<SurrogateGrain, { kind: 'MoonBurner' }>;
    const breakthrough = g.outer_radius - g.core_radius - g.offset;
    expect(breakthrough).toBeGreaterThan(0);

    const before = outlineAt(g, breakthrough * 0.8);
    const after = outlineAt(g, breakthrough * 1.5);
    const maxR = (o: ReturnType<typeof outlineAt>) =>
      Math.max(...o.port.flat().map((p) => Math.hypot(p.x, p.y)));
    expect(maxR(before)).toBeLessThan(g.outer_radius * 0.999);
    expect(maxR(after)).toBeGreaterThan(g.outer_radius * 0.999);
  });

  it('handles a Custom DXF profile like any other geometry', () => {
    // A square bore, which no analytic model in engine.ts describes.
    const square = [
      { x: -0.012, y: -0.012 },
      { x: 0.012, y: -0.012 },
      { x: 0.012, y: 0.012 },
      { x: -0.012, y: 0.012 },
    ];
    const g: SurrogateGrain = {
      kind: 'CustomDXF',
      length: LEN,
      outer_radius: 0.05,
      dx: 0.0005,
      perim_table: [],
      area_table: [],
      base_polygon: [square],
    };
    expect(outlineAt(g, 0).area).toBeCloseTo(0.024 * 0.024, 6);

    // Offsetting rounds the corners, so the grown area exceeds the naive
    // square-plus-band and the difference is the corner fillets.
    const y = 0.006;
    const grown = outlineAt(g, y);
    const naive = (0.024 + 2 * y) ** 2;
    expect(grown.area).toBeLessThan(naive);
    expect(grown.area).toBeGreaterThan(0.024 * 0.024);
    expect(grown.port[0].length).toBeGreaterThan(20); // corners are now arcs
  });
});
