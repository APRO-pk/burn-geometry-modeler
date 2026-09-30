/**
 * STL and SCAD geometry export utilities.
 *
 * Extracted from AppDesktop to keep the component focused on UI. The download
 * triggers and React state interactions stay in the component; this module
 * handles only the geometry string generation.
 */

function addFacet(v1: number[], v2: number[], v3: number[]): string {
  const ux = v2[0] - v1[0], uy = v2[1] - v1[1], uz = v2[2] - v1[2];
  const vx = v3[0] - v1[0], vy = v3[1] - v1[1], vz = v3[2] - v1[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 1e-6) { nx /= len; ny /= len; nz /= len; }
  let s = `  facet normal ${nx.toExponential(6)} ${ny.toExponential(6)} ${nz.toExponential(6)}\n    outer loop\n`;
  s += `      vertex ${v1[0].toExponential(6)} ${v1[1].toExponential(6)} ${v1[2].toExponential(6)}\n`;
  s += `      vertex ${v2[0].toExponential(6)} ${v2[1].toExponential(6)} ${v2[2].toExponential(6)}\n`;
  s += `      vertex ${v3[0].toExponential(6)} ${v3[1].toExponential(6)} ${v3[2].toExponential(6)}\n`;
  s += `    endloop\n  endfacet\n`;
  return s;
}

// ── Grain STL ──

export interface GrainSTLParams {
  grainType: string;
  innerRadius: number;
  outerRadius: number;
  tipRadius: number;
  valleyRadius: number;
  numPoints: number;
  offset: number;
  finDepth: number;
  finWidth: number;
  rodRadius: number;
  length: number;
  numSegments: number;
  dxfData: { areaTable: number[] } | null;
}

export function generateGrainSTL(p: GrainSTLParams): string {
  let stl = 'solid motor_grain\n';
  const radialSteps = 120;
  const innerProfile: number[][] = [];
  const outerProfile: number[][] = [];
  const rodProfile: number[][] | null = p.grainType === 'RodAndTube' ? [] : null;

  for (let i = 0; i < radialSteps; i++) {
    const a = (i * 2 * Math.PI) / radialSteps;
    let r_in = p.innerRadius;
    let cx = 0;
    const cy = 0;
    if (p.grainType === 'Star') {
      const sector = (2 * Math.PI) / p.numPoints;
      let local_a = a % sector;
      if (local_a > sector / 2) local_a = sector - local_a;
      r_in = p.tipRadius + (p.valleyRadius - p.tipRadius) * (local_a / (sector / 2));
    } else if (p.grainType === 'Tubular' || p.grainType === 'BATES' || p.grainType === 'RodAndTube') {
      r_in = p.innerRadius;
    } else if (p.grainType === 'MoonBurner') {
      r_in = p.innerRadius;
      cx = p.offset;
    } else if (p.grainType === 'CustomDXF') {
      r_in = p.dxfData ? Math.sqrt(p.dxfData.areaTable[0] / Math.PI) : p.innerRadius;
    } else if (p.grainType === 'Finocyl') {
      const a_core = Math.PI * Math.pow(p.innerRadius, 2);
      const tip_center = p.finDepth - p.finWidth / 2.0;
      const fin_area = p.numPoints * (tip_center * p.finWidth + Math.PI * Math.pow(p.finWidth / 2, 2) / 2);
      r_in = Math.sqrt((a_core + fin_area) / Math.PI);
    }
    if (r_in > p.outerRadius) r_in = p.outerRadius;

    innerProfile.push([cx + Math.cos(a) * r_in, cy + Math.sin(a) * r_in]);
    outerProfile.push([Math.cos(a) * p.outerRadius, Math.sin(a) * p.outerRadius]);
    if (rodProfile) rodProfile.push([Math.cos(a) * p.rodRadius, Math.sin(a) * p.rodRadius]);
  }

  const segments = p.grainType === 'BATES' ? p.numSegments : 1;
  const gap = 2;

  for (let s = 0; s < segments; s++) {
    const z0 = s * (p.length + gap);
    const z1 = z0 + p.length;

    for (let i = 0; i < radialSteps; i++) {
      const next_i = (i + 1) % radialSteps;
      const p1_in = [...innerProfile[i], z0];
      const p2_in = [...innerProfile[next_i], z0];
      const p3_in = [...innerProfile[next_i], z1];
      const p4_in = [...innerProfile[i], z1];

      const p1_out = [...outerProfile[i], z0];
      const p2_out = [...outerProfile[next_i], z0];
      const p3_out = [...outerProfile[next_i], z1];
      const p4_out = [...outerProfile[i], z1];

      stl += addFacet(p1_in, p2_in, p1_out);
      stl += addFacet(p2_in, p2_out, p1_out);
      stl += addFacet(p4_in, p4_out, p3_in);
      stl += addFacet(p3_in, p4_out, p3_out);
      stl += addFacet(p1_in, p4_in, p2_in);
      stl += addFacet(p4_in, p3_in, p2_in);
      stl += addFacet(p1_out, p2_out, p4_out);
      stl += addFacet(p2_out, p3_out, p4_out);

      if (rodProfile) {
        const r1 = [...rodProfile[i], z0];
        const r2 = [...rodProfile[next_i], z0];
        const r3 = [...rodProfile[next_i], z1];
        const r4 = [...rodProfile[i], z1];
        stl += addFacet([0, 0, z0], r2, r1);
        stl += addFacet([0, 0, z1], r4, r3);
        stl += addFacet(r1, r2, r4);
        stl += addFacet(r2, r3, r4);
      }
    }
  }

  stl += 'endsolid motor_grain\n';
  return stl;
}

// ── Casing profiles ──

export interface CasingProfileParams {
  outerRadius: number;
  caseWallThickness: number;
  length: number;
  throatDiameter: number;
  expansionRatio: number;
  boltDiameter: number;
}

export function getCasingProfiles(p: CasingProfileParams) {
  const innerRadiusMM = p.outerRadius * 1000;
  let casingThicknessMM = p.caseWallThickness;
  if (casingThicknessMM < 0.1) casingThicknessMM *= 1000;
  const outerRadiusMM = innerRadiusMM + casingThicknessMM;
  const lengthMM = p.length * 1000;
  const throatRadiusMM = (p.throatDiameter * 1000) / 2;
  const expRatio = p.expansionRatio || 3.0;
  const exitRadiusMM = throatRadiusMM * Math.sqrt(expRatio);

  const flangeThick = Math.max(p.boltDiameter * 1.5, 5);
  const flangeR = outerRadiusMM + Math.max(p.boltDiameter * 1.5, 8);
  const nozzleThick = Math.max(casingThicknessMM * 1.5, 5.0);
  const domeSteps = 16;

  const mainTubeProf = [
    [lengthMM, innerRadiusMM],
    [0, innerRadiusMM],
    [0, flangeR],
    [flangeThick, flangeR],
    [flangeThick, outerRadiusMM],
    [lengthMM - flangeThick, outerRadiusMM],
    [lengthMM - flangeThick, flangeR],
    [lengthMM, flangeR],
  ];

  const fwdProf: number[][] = [];
  for (let i = domeSteps; i >= 0; i--) {
    const theta = (i / domeSteps) * (Math.PI / 2);
    fwdProf.push([
      lengthMM + flangeThick + outerRadiusMM * Math.sin(theta),
      Math.max(0.001, outerRadiusMM * Math.cos(theta)),
    ]);
  }
  fwdProf.push([lengthMM + flangeThick, flangeR]);
  fwdProf.push([lengthMM, flangeR]);
  fwdProf.push([lengthMM, Math.max(0.001, innerRadiusMM)]);
  for (let i = 0; i <= domeSteps; i++) {
    const theta = (i / domeSteps) * (Math.PI / 2);
    fwdProf.push([
      lengthMM + innerRadiusMM * Math.sin(theta),
      Math.max(0.001, innerRadiusMM * Math.cos(theta)),
    ]);
  }

  const exitLength = throatRadiusMM * 6;
  const nozzleConvLen = throatRadiusMM * 3;
  const aftProf = [
    [0, Math.max(0.001, innerRadiusMM)],
    [0, flangeR],
    [-flangeThick, flangeR],
    [-flangeThick, outerRadiusMM],
    [-nozzleConvLen, throatRadiusMM + nozzleThick],
    [-nozzleConvLen - exitLength, exitRadiusMM + nozzleThick],
    [-nozzleConvLen - exitLength, Math.max(0.001, exitRadiusMM)],
    [-nozzleConvLen, Math.max(0.001, throatRadiusMM)],
  ];

  return { mainTubeProf, fwdProf, aftProf };
}

// ── Profile-to-STL (for casing parts) ──

export function generateProfileSTL(prof: number[][], name: string): string {
  let stl = `solid ${name}\n`;
  const radialSteps = 120;

  for (let i = 0; i < radialSteps; i++) {
    const a1 = (i * 2 * Math.PI) / radialSteps;
    const a2 = ((i + 1) * 2 * Math.PI) / radialSteps;

    for (let p = 0; p < prof.length; p++) {
      const pNext = (p + 1) % prof.length;
      const z1 = prof[p][0], r1 = prof[p][1];
      const z2 = prof[pNext][0], r2 = prof[pNext][1];

      if (Math.abs(z1 - z2) < 1e-6 && Math.abs(r1 - r2) < 1e-6) continue;

      const p1_a1 = [r1 * Math.cos(a1), r1 * Math.sin(a1), z1];
      const p1_a2 = [r1 * Math.cos(a2), r1 * Math.sin(a2), z1];
      const p2_a1 = [r2 * Math.cos(a1), r2 * Math.sin(a1), z2];
      const p2_a2 = [r2 * Math.cos(a2), r2 * Math.sin(a2), z2];

      stl += addFacet(p1_a1, p2_a1, p1_a2);
      stl += addFacet(p1_a2, p2_a1, p2_a2);
    }
  }
  stl += `endsolid ${name}\n`;
  return stl;
}

// ── SCAD ──

export function generateSCAD(profiles: {
  mainTubeProf: number[][];
  fwdProf: number[][];
  aftProf: number[][];
}): string {
  const serializeProf = (p: number[][]) =>
    p.map((pt) => `[${pt[1].toFixed(4)}, ${pt[0].toFixed(4)}]`).join(', ');

  let scad = `// APRO Assembly Components\n`;
  scad += `// This SCAD file can be opened in OpenSCAD or FreeCAD\n`;
  scad += `// and subsequently exported directly to STEP, IGES, or Parasolid.\n\n`;
  scad += `$fn = 120; // Resolution\n\n`;
  scad += `module MainTube() {\n  rotate_extrude(angle=360)\n    polygon(points=[\n      ${serializeProf(profiles.mainTubeProf)}\n    ]);\n}\n\n`;
  scad += `module ForwardClosure() {\n  rotate_extrude(angle=360)\n    polygon(points=[\n      ${serializeProf(profiles.fwdProf)}\n    ]);\n}\n\n`;
  scad += `module AftClosure() {\n  rotate_extrude(angle=360)\n    polygon(points=[\n      ${serializeProf(profiles.aftProf)}\n    ]);\n}\n\n`;
  scad += `// Display Full Assembly\n`;
  scad += `MainTube();\nForwardClosure();\nAftClosure();\n`;
  return scad;
}
