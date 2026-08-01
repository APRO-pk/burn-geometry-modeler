import DxfParser from 'dxf-parser';
import * as ClipperLib from 'clipper-lib';

export interface DXFRegressionResults {
  dx: number;
  perimTable: number[];
  areaTable: number[];
  outerRadius: number;
}

const SCALE = 1000000.0;

export function processDXF(dxfText: string, maxRadius: number, dx: number): DXFRegressionResults {
  const parser = new DxfParser();
  const dxf = parser.parseSync(dxfText);

  const paths: ClipperLib.Path[] = [];

  // Very simple parsing: we look for LWPOLYLINE and CIRCLE
  // For complex cases we should join lines and arcs, but we'll assume clean closed paths
  if (dxf && dxf.entities) {
    for (const rawEntity of dxf.entities) {
      const entity = rawEntity as any;
      if (entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') {
         if (entity.vertices && entity.vertices.length > 0) {
            const path: ClipperLib.Path = [];
            for (const v of entity.vertices) {
              path.push({ X: Math.round(v.x * SCALE), Y: Math.round(v.y * SCALE) });
            }
            if (entity.shape) { // closed
               paths.push(path);
            } else if (entity.vertices[0].x === entity.vertices[entity.vertices.length-1].x && entity.vertices[0].y === entity.vertices[entity.vertices.length-1].y) {
               paths.push(path);
            }
         }
      } else if (entity.type === 'CIRCLE') {
          const path: ClipperLib.Path = [];
          const center = entity.center;
          const r = entity.radius;
          const steps = 64;
          for (let i = 0; i < steps; i++) {
             const a = i * 2 * Math.PI / steps;
             const px = center.x + Math.cos(a) * r;
             const py = center.y + Math.sin(a) * r;
             path.push({ X: Math.round(px * SCALE), Y: Math.round(py * SCALE) });
          }
          paths.push(path);
      }
    }
  }

  // Unite all paths initially to form the core geometry
  let subj: ClipperLib.Paths = [];
  paths.forEach(p => subj.push(p));
  
  const c = new ClipperLib.Clipper();
  c.AddPaths(subj, ClipperLib.PolyType.ptSubject, true);
  let initialPort: ClipperLib.Paths = [];
  c.Execute(ClipperLib.ClipType.ctUnion, initialPort, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);

  const perimTable: number[] = [];
  const areaTable: number[] = [];

  let currentY = 0;
  
  while (currentY < maxRadius) {
     const co = new ClipperLib.ClipperOffset();
     co.AddPaths(initialPort, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
     let offsetPaths: ClipperLib.Paths = [];
     co.Execute(offsetPaths, currentY * SCALE);

     // clip against outer radius
     const outerCircle: ClipperLib.Path = [];
     for (let i = 0; i < 128; i++) {
        const a = i * 2 * Math.PI / 128;
        outerCircle.push({ X: Math.round(Math.cos(a) * maxRadius * SCALE), Y: Math.round(Math.sin(a) * maxRadius * SCALE) });
     }
     
     const c2 = new ClipperLib.Clipper();
     c2.AddPaths(offsetPaths, ClipperLib.PolyType.ptSubject, true);
     c2.AddPath(outerCircle, ClipperLib.PolyType.ptClip, true);
     let finalPaths: ClipperLib.Paths = [];
     c2.Execute(ClipperLib.ClipType.ctIntersection, finalPaths, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);

     if (finalPaths.length === 0) {
        break; // consumed
     }

     let area = 0;
     let peri = 0;
     for (const p of finalPaths) {
         // Area returns positive for outer, negative for hole. Absolute for true area since intersection output is predictable
         area += Math.abs(ClipperLib.Clipper.Area(p)) / (SCALE * SCALE);
         
         // Perimeter
         for (let i = 0; i < p.length; i++) {
            const p1 = p[i];
            const p2 = p[(i + 1) % p.length];
            const px = (p1.X - p2.X) / SCALE;
            const py = (p1.Y - p2.Y) / SCALE;
            // Only add perimeter if it's not on the outer casing?
            // Actually, we must exclude the perimeter that is strictly on the boundary of maxRadius.
            const dist1 = Math.sqrt(Math.pow(p1.X/SCALE, 2) + Math.pow(p1.Y/SCALE, 2));
            const dist2 = Math.sqrt(Math.pow(p2.X/SCALE, 2) + Math.pow(p2.Y/SCALE, 2));
            if (dist1 < maxRadius - 1e-4 || dist2 < maxRadius - 1e-4) {
                peri += Math.sqrt(px*px + py*py);
            }
         }
     }

     perimTable.push(peri);
     areaTable.push(area);
     
     currentY += dx;
  }

  // Ensure it reaches terminal correctly
  perimTable.push(0);
  areaTable.push(Math.PI * maxRadius * maxRadius);

  return { dx, perimTable, areaTable, outerRadius: maxRadius };
}
