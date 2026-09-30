import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Close, Pause, Play, Reset, Trash } from './ui/icons';
import * as THREE from 'three';
import { outlineAt } from './grainOutline';
import type { GrainOutline, Pt } from './grainOutline';
import { grainFromConfig, burnoutWeb } from './surrogate/features';
import type { SurrogateGrain } from './surrogate/features';
import type { SimulationResult } from './engine';
import type { StationProfiles } from './wasmCore';
import type { StructuralResult, StressProfile } from './wasmCore';

const WEB_STEPS = 240;

const PROPELLANT = 0x9a8f7a;
const CASING_COLOR = 0x4a5568;

// ── Color maps ──

type ColorMap = 'jet' | 'viridis' | 'thermal' | 'coolwarm';

function sampleColorMap(t: number, map: ColorMap): THREE.Color {
  const s = Math.max(0, Math.min(1, t));
  if (map === 'jet') {
    const r = Math.min(1, Math.max(0, 1.5 - Math.abs(4 * s - 3)));
    const g = Math.min(1, Math.max(0, 1.5 - Math.abs(4 * s - 2)));
    const b = Math.min(1, Math.max(0, 1.5 - Math.abs(4 * s - 1)));
    return new THREE.Color(r, g, b);
  }
  if (map === 'thermal') {
    return new THREE.Color().setHSL((1 - s) * 0.7, 0.9, 0.35 + s * 0.3);
  }
  if (map === 'coolwarm') {
    const r = s;
    const b = 1 - s;
    const g = 1 - 2 * Math.abs(s - 0.5);
    return new THREE.Color(r * 0.9 + 0.1, g * 0.5, b * 0.9 + 0.1);
  }
  // viridis approximation
  const r = Math.max(0, Math.min(1, -0.27 + 4.36 * s - 9.11 * s * s + 8.1 * s * s * s - 2.26 * s * s * s * s));
  const g = Math.max(0, Math.min(1, 0.004 + 1.42 * s - 1.77 * s * s + 1.31 * s * s * s - 0.55 * s * s * s * s));
  const b = Math.max(0, Math.min(1, 0.33 + 1.74 * s - 5.09 * s * s + 6.06 * s * s * s - 2.61 * s * s * s * s));
  return new THREE.Color(r, g, b);
}

// ── View / field types ──

type ViewMode = 'solid' | 'xray' | 'cutaway';

type FieldId =
  | 'none'
  | 'pressure'
  | 'burnRate'
  | 'massFlux'
  | 'erosiveRate'
  | 'temperature'
  | 'hoopStress'
  | 'vonMises'
  | 'safetyFactor';

const FIELD_LABELS: Record<FieldId, string> = {
  none: 'Solid color',
  pressure: 'Pressure (MPa)',
  burnRate: 'Burn rate (mm/s)',
  massFlux: 'Mass flux (kg/m²s)',
  erosiveRate: 'Erosive rate (mm/s)',
  temperature: 'Temperature (K)',
  hoopStress: 'Hoop stress (MPa)',
  vonMises: 'Von Mises (MPa)',
  safetyFactor: 'Safety factor',
};

interface ProbePoint {
  id: number;
  position: THREE.Vector3;
  normal: THREE.Vector3;
  meshType: 'grain' | 'casing';
  axialFrac: number;
  radialFrac: number;
}

interface Props {
  grain: SurrogateGrain;
  results: SimulationResult[];
  stations?: StationProfiles;
  structural?: StructuralResult;
  caseWallThickness: number;
  casingYieldStress: number;
  maxPc: number;
  flameTemp: number;
  addLog?: (msg: string) => void;
}

// ── Mesh building ──

function ringToShapePath(ring: Pt[]): THREE.Path {
  const p = new THREE.Path();
  p.moveTo(ring[0].x, ring[0].y);
  for (let i = 1; i < ring.length; i++) p.lineTo(ring[i].x, ring[i].y);
  p.closePath();
  return p;
}

function buildGrainGeometry(o: GrainOutline): THREE.BufferGeometry | null {
  if (o.burnedOut || o.length <= 0) return null;

  const outer = new THREE.Shape();
  const seg = 192;
  for (let i = 0; i <= seg; i++) {
    const a = (2 * Math.PI * i) / seg;
    const x = o.outerRadius * Math.cos(a);
    const y = o.outerRadius * Math.sin(a);
    if (i === 0) outer.moveTo(x, y);
    else outer.lineTo(x, y);
  }
  for (const ring of o.port) {
    if (ring.length > 2) outer.holes.push(ringToShapePath(ring));
  }

  const shapes: THREE.Shape[] = [outer];
  for (const island of o.islands) {
    if (island.length > 2) {
      const s = new THREE.Shape();
      s.moveTo(island[0].x, island[0].y);
      for (let i = 1; i < island.length; i++) s.lineTo(island[i].x, island[i].y);
      s.closePath();
      shapes.push(s);
    }
  }

  try {
    const geo = new THREE.ExtrudeGeometry(shapes, {
      depth: o.length,
      bevelEnabled: false,
      curveSegments: 64,
    });
    geo.translate(0, 0, -o.length / 2);
    geo.computeVertexNormals();
    return geo;
  } catch {
    return null;
  }
}

function buildCasingGeometry(
  innerR: number,
  wallThickness: number,
  length: number,
): THREE.BufferGeometry {
  const outerR = innerR + wallThickness;
  const seg = 96;
  const rings = 32;

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  // Outer surface
  for (let j = 0; j <= rings; j++) {
    const z = -length / 2 + (j / rings) * length;
    for (let i = 0; i <= seg; i++) {
      const a = (2 * Math.PI * i) / seg;
      const x = outerR * Math.cos(a);
      const y = outerR * Math.sin(a);
      positions.push(x, y, z);
      normals.push(Math.cos(a), Math.sin(a), 0);
    }
  }
  const outerVerts = (rings + 1) * (seg + 1);
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i;
      const b = a + seg + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  // Inner surface
  const innerOffset = outerVerts;
  for (let j = 0; j <= rings; j++) {
    const z = -length / 2 + (j / rings) * length;
    for (let i = 0; i <= seg; i++) {
      const a = (2 * Math.PI * i) / seg;
      const x = innerR * Math.cos(a);
      const y = innerR * Math.sin(a);
      positions.push(x, y, z);
      normals.push(-Math.cos(a), -Math.sin(a), 0);
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < seg; i++) {
      const a = innerOffset + j * (seg + 1) + i;
      const b = a + seg + 1;
      indices.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  return geo;
}

function applyContourColors(
  geo: THREE.BufferGeometry,
  length: number,
  fieldValues: Float64Array | number[] | null,
  fieldMin: number,
  fieldMax: number,
  colorMap: ColorMap,
  isCasing: boolean,
  wallThickness: number,
  innerRadius: number,
  stressProfile?: StressProfile,
): void {
  const pos = geo.getAttribute('position');
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  const range = fieldMax - fieldMin || 1;

  for (let i = 0; i < count; i++) {
    const z = pos.getZ(i);
    let t = 0;

    if (isCasing && stressProfile && stressProfile.position.length > 1) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const r = Math.sqrt(x * x + y * y);
      const radialFrac = Math.max(0, Math.min(1, (r - innerRadius) / wallThickness));
      const idx = Math.min(stressProfile.position.length - 1, Math.round(radialFrac * (stressProfile.position.length - 1)));
      const val = stressProfile.vonMises[idx];
      t = (val - fieldMin) / range;
    } else if (fieldValues && fieldValues.length > 1) {
      const axialFrac = (z + length / 2) / length;
      const idx = Math.min(fieldValues.length - 1, Math.max(0, Math.round(axialFrac * (fieldValues.length - 1))));
      t = (fieldValues[idx] - fieldMin) / range;
    } else if (fieldValues && fieldValues.length === 1) {
      t = (fieldValues[0] - fieldMin) / range;
    }

    const c = sampleColorMap(t, colorMap);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
}

// ── Color legend component ──

function ColorLegend({ min, max, unit, colorMap, label }: {
  min: number; max: number; unit: string; colorMap: ColorMap; label: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const w = cv.width;
    const h = cv.height;
    for (let x = 0; x < w; x++) {
      const t = x / (w - 1);
      const c = sampleColorMap(t, colorMap);
      ctx.fillStyle = `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
      ctx.fillRect(x, 0, 1, h);
    }
  }, [min, max, colorMap]);

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[9px] text-[var(--t-secondary)]">{label}</span>
      <canvas ref={canvasRef} width={200} height={12} className="w-full h-3 border border-[var(--b-soft)]" />
      <div className="flex justify-between text-[9px] text-[var(--t-muted)]">
        <span>{min.toFixed(2)} {unit}</span>
        <span>{max.toFixed(2)} {unit}</span>
      </div>
    </div>
  );
}

// ── Main component ──

export function GrainBurn3D({
  grain,
  results,
  stations,
  structural,
  caseWallThickness,
  casingYieldStress,
  maxPc,
  flameTemp,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    grainMesh: THREE.Mesh | null;
    casingMesh: THREE.Mesh | null;
    clipPlane: THREE.Plane;
    probeMarkers: THREE.Group;
    dispose: () => void;
    frame?: (r: number, len: number) => void;
    raycaster: THREE.Raycaster;
    pointer: THREE.Vector2;
  } | null>(null);

  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [showCasing, setShowCasing] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>('solid');
  const [field, setField] = useState<FieldId>('none');
  const [colorMap, setColorMap] = useState<ColorMap>('jet');
  const [probes, setProbes] = useState<ProbePoint[]>([]);
  const [nextProbeId, setNextProbeId] = useState(1);
  const [clipAngle, setClipAngle] = useState(0);

  const web = useMemo(() => burnoutWeb(grainFromConfig(grain)), [grain]);

  const timeline = useMemo(() => {
    const usable = results.filter((r) => Number.isFinite(r.y));
    if (usable.length < 2) return null;
    return { duration: usable[usable.length - 1].Time, rows: usable };
  }, [results]);

  const current = useMemo(() => {
    if (!timeline) return { y: progress * web, row: null as SimulationResult | null, t: 0 };
    const idx = Math.min(
      timeline.rows.length - 1,
      Math.max(0, Math.round(progress * (timeline.rows.length - 1)))
    );
    const row = timeline.rows[idx];
    return { y: row.y, row, t: row.Time };
  }, [timeline, progress, web]);

  const quantWeb = Math.round((current.y / Math.max(web, 1e-9)) * WEB_STEPS) / WEB_STEPS;

  const outline = useMemo(
    () => outlineAt(grain, quantWeb * web),
    [grain, quantWeb, web]
  );

  // Compute field data ranges for the legend
  const fieldData = useMemo(() => {
    if (field === 'none') return null;

    if ((field === 'hoopStress' || field === 'vonMises' || field === 'safetyFactor') && structural) {
      const prof = structural.lame.profile;
      let values: Float64Array;
      if (field === 'hoopStress') values = prof.hoop;
      else if (field === 'vonMises') values = prof.vonMises;
      else values = new Float64Array(prof.vonMises.length);
      if (field === 'safetyFactor') {
        const ys = casingYieldStress * 1e6;
        for (let i = 0; i < prof.vonMises.length; i++) {
          (values as Float64Array)[i] = prof.vonMises[i] > 0 ? ys / prof.vonMises[i] : 99;
        }
      }
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < values.length; i++) {
        if (values[i] < mn) mn = values[i];
        if (values[i] > mx) mx = values[i];
      }
      const scale = field === 'safetyFactor' ? 1 : 1e-6;
      const unit = field === 'safetyFactor' ? '' : 'MPa';
      return { values: null, min: mn * scale, max: mx * scale, unit, isCasing: true, stressProfile: prof };
    }

    if (stations && stations.count > 1) {
      let raw: Float64Array;
      let unit = '';
      let scale = 1;
      switch (field) {
        case 'pressure': raw = stations.pressure; unit = 'MPa'; scale = 1e-6; break;
        case 'burnRate': raw = stations.burnRate; unit = 'mm/s'; scale = 1000; break;
        case 'massFlux': raw = stations.massFlux; unit = 'kg/m²s'; break;
        case 'erosiveRate': raw = stations.erosiveRate; unit = 'mm/s'; scale = 1000; break;
        case 'temperature': {
          const arr = new Float64Array(stations.count);
          for (let i = 0; i < stations.count; i++) {
            arr[i] = flameTemp * (1 - 0.15 * (1 - stations.pressure[i] / (maxPc || 1)));
          }
          raw = arr;
          unit = 'K';
          break;
        }
        default: return null;
      }
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < raw.length; i++) {
        const v = raw[i] * scale;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const scaled = new Float64Array(raw.length);
      for (let i = 0; i < raw.length; i++) scaled[i] = raw[i] * scale;
      return { values: scaled, min: mn, max: mx, unit, isCasing: false };
    }

    // 0-D fallback: uniform field from the current timestep
    if (current.row && (field === 'pressure' || field === 'temperature')) {
      const val = field === 'pressure' ? current.row.Pc * 1e-6 : flameTemp;
      const unit = field === 'pressure' ? 'MPa' : 'K';
      return { values: new Float64Array([val]), min: val * 0.9, max: val * 1.1, unit, isCasing: false };
    }

    return null;
  }, [field, stations, structural, current.row, casingYieldStress, maxPc, flameTemp]);

  // Probe values at current field
  const probeValues = useMemo(() => {
    if (!fieldData || !fieldData.values) return probes.map(() => '—');
    return probes.map((p) => {
      if (!fieldData.values) return '—';
      const idx = Math.min(fieldData.values.length - 1, Math.max(0, Math.round(p.axialFrac * (fieldData.values.length - 1))));
      return `${fieldData.values[idx].toFixed(2)} ${fieldData.unit}`;
    });
  }, [probes, fieldData]);

  // ── Scene setup ──
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0a);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 100);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.localClippingEnabled = true;
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(1, 1.2, 1.6);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x88bbff, 0.5);
    rim.position.set(-1.5, -0.6, -1);
    scene.add(rim);

    const clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);

    const probeMarkers = new THREE.Group();
    scene.add(probeMarkers);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    // Orbit controls
    let theta = 0.9, phi = 1.15, radius = 1, radius0 = 1;
    let dragging = false, lastX = 0, lastY = 0;

    const applyCamera = () => {
      camera.position.set(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.sin(theta)
      );
      camera.lookAt(0, 0, 0);
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      renderer.domElement.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      theta -= (e.clientX - lastX) * 0.008;
      phi = Math.min(Math.PI - 0.05, Math.max(0.05, phi - (e.clientY - lastY) * 0.008));
      lastX = e.clientX;
      lastY = e.clientY;
      applyCamera();
    };
    const onUp = (e: PointerEvent) => {
      dragging = false;
      try { renderer.domElement.releasePointerCapture(e.pointerId); } catch { /* */ }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      radius = Math.min(6 * radius0, Math.max(0.3 * radius0, radius * (1 + e.deltaY * 0.001)));
      applyCamera();
    };

    const el = renderer.domElement;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });

    // Context menu for probing
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    let raf = 0;
    const resize = () => {
      const w = mount.clientWidth || 640;
      const h = mount.clientHeight || 420;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();

    const loop = () => {
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();

    const ctx = {
      renderer, scene, camera, grainMesh: null as THREE.Mesh | null,
      casingMesh: null as THREE.Mesh | null, clipPlane, probeMarkers,
      dispose: () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        el.removeEventListener('pointerdown', onDown);
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        el.removeEventListener('wheel', onWheel);
        renderer.dispose();
        if (el.parentNode) el.parentNode.removeChild(el);
      },
      raycaster, pointer,
      frame: (r: number, len: number) => {
        radius0 = Math.max(r * 4.2, len * 1.9);
        radius = radius0;
        applyCamera();
        camera.near = radius0 / 200;
        camera.far = radius0 * 20;
        camera.updateProjectionMatrix();
      },
    };
    sceneRef.current = ctx;
    applyCamera();
    return () => { ctx.dispose(); sceneRef.current = null; };
  }, []);

  // ── Right-click probe placement ──
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const s = sceneRef.current;
    if (!s) return;
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    s.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    s.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    s.raycaster.setFromCamera(s.pointer, s.camera);

    const meshes: THREE.Mesh[] = [];
    if (s.grainMesh) meshes.push(s.grainMesh);
    if (s.casingMesh) meshes.push(s.casingMesh);
    const hits = s.raycaster.intersectObjects(meshes);
    if (hits.length === 0) return;

    const hit = hits[0];
    const pt = hit.point;
    const isGrain = hit.object === s.grainMesh;
    const len = grain.length;
    const axialFrac = Math.max(0, Math.min(1, (pt.z + len / 2) / len));
    const r = Math.sqrt(pt.x * pt.x + pt.y * pt.y);
    const radialFrac = r / (grain.outer_radius + (caseWallThickness || 0));

    setProbes((prev) => [...prev, {
      id: nextProbeId, position: pt.clone(),
      normal: hit.face?.normal.clone() || new THREE.Vector3(0, 1, 0),
      meshType: isGrain ? 'grain' : 'casing',
      axialFrac, radialFrac,
    }]);
    setNextProbeId((n) => n + 1);
  }, [grain, caseWallThickness, nextProbeId]);

  // ── Update probe markers ──
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    while (s.probeMarkers.children.length > 0) {
      const c = s.probeMarkers.children[0];
      s.probeMarkers.remove(c);
      if (c instanceof THREE.Mesh) { c.geometry.dispose(); (c.material as THREE.Material).dispose(); }
    }
    for (const p of probes) {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(grain.outer_radius * 0.04, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0xff3333 })
      );
      marker.position.copy(p.position);
      s.probeMarkers.add(marker);
    }
  }, [probes, grain.outer_radius]);

  // ── Clip plane angle ──
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    const angle = (clipAngle * Math.PI) / 180;
    s.clipPlane.normal.set(-Math.cos(angle), -Math.sin(angle), 0);
  }, [clipAngle]);

  // ── Swap grain mesh ──
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;

    if (s.grainMesh) {
      s.scene.remove(s.grainMesh);
      s.grainMesh.geometry.dispose();
      (s.grainMesh.material as THREE.Material).dispose();
      s.grainMesh = null;
    }

    const geo = buildGrainGeometry(outline);
    if (geo) {
      const useContour = field !== 'none' && fieldData && !fieldData.isCasing;
      if (useContour && fieldData) {
        applyContourColors(
          geo, grain.length, fieldData.values, fieldData.min, fieldData.max,
          colorMap, false, caseWallThickness, grain.outer_radius,
        );
      }

      const mat = new THREE.MeshStandardMaterial({
        color: useContour ? 0xffffff : PROPELLANT,
        vertexColors: !!useContour,
        roughness: 0.85,
        metalness: 0.05,
        side: THREE.DoubleSide,
        transparent: viewMode === 'xray',
        opacity: viewMode === 'xray' ? 0.35 : 1.0,
        clippingPlanes: viewMode === 'cutaway' ? [s.clipPlane] : [],
        clipShadows: true,
      });

      const mesh = new THREE.Mesh(geo, mat);
      s.scene.add(mesh);
      s.grainMesh = mesh;
    }

    s.frame?.(outline.outerRadius, grain.length);
  }, [outline, viewMode, field, fieldData, colorMap, grain.length, grain.outer_radius, caseWallThickness]);

  // ── Swap casing mesh ──
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;

    if (s.casingMesh) {
      s.scene.remove(s.casingMesh);
      s.casingMesh.geometry.dispose();
      (s.casingMesh.material as THREE.Material).dispose();
      s.casingMesh = null;
    }

    if (!showCasing) return;

    const wall = caseWallThickness > 0.0001 ? caseWallThickness : grain.outer_radius * 0.05;
    const geo = buildCasingGeometry(grain.outer_radius, wall, grain.length);

    const useContour = field !== 'none' && fieldData && fieldData.isCasing;
    if (useContour && fieldData) {
      applyContourColors(
        geo, grain.length, null, fieldData.min, fieldData.max,
        colorMap, true, wall, grain.outer_radius, fieldData.stressProfile,
      );
    }

    const mat = new THREE.MeshStandardMaterial({
      color: useContour ? 0xffffff : CASING_COLOR,
      vertexColors: !!useContour,
      metalness: 0.7,
      roughness: 0.45,
      transparent: viewMode !== 'solid' || !useContour,
      opacity: viewMode === 'xray' ? 0.12 : (useContour ? 1.0 : 0.18),
      side: THREE.DoubleSide,
      clippingPlanes: viewMode === 'cutaway' ? [s.clipPlane] : [],
    });

    const mesh = new THREE.Mesh(geo, mat);
    s.scene.add(mesh);
    s.casingMesh = mesh;
  }, [showCasing, grain.outer_radius, grain.length, caseWallThickness, viewMode, field, fieldData, colorMap]);

  // ── Playback ──
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const step = () => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      setProgress((p) => {
        const next = p + dt / 6;
        if (next >= 1) { setPlaying(false); return 1; }
        return next;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const reset = useCallback(() => { setPlaying(false); setProgress(0); }, []);

  const eng = useMemo(() => grainFromConfig(grain), [grain]);
  const analyticAb = eng.get_burning_area(current.y);
  const analyticPort = eng.get_port_area(current.y);

  const availableFields = useMemo(() => {
    const fields: FieldId[] = ['none'];
    if (stations || current.row) {
      fields.push('pressure');
      if (stations) {
        fields.push('burnRate', 'massFlux', 'erosiveRate');
      }
      fields.push('temperature');
    }
    if (structural) {
      fields.push('hoopStress', 'vonMises', 'safetyFactor');
    }
    return fields;
  }, [stations, current.row, structural]);

  return (
    <div className="w-full space-y-2 text-xs">
      {/* 3D viewport */}
      <div
        ref={mountRef}
        onContextMenu={handleContextMenu}
        className="w-full h-[480px] border border-[var(--b-soft)] bg-black relative overflow-hidden"
      >
        <div className="absolute top-2 left-2 z-10 text-[var(--t-muted)] text-[10px] pointer-events-none select-none">
          left-drag: orbit &middot; scroll: zoom &middot; right-click: probe
        </div>
        {outline.burnedOut && (
          <div className="absolute inset-0 flex items-center justify-center text-[var(--sem-warn)] text-sm pointer-events-none">
            GRAIN CONSUMED
          </div>
        )}
      </div>

      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-2 p-2 bg-[var(--s-sunken)] border border-[var(--b-soft)]">
        {/* View mode */}
        <div className="flex items-center gap-1">
          <span className="text-[var(--t-secondary)] text-[10px] font-bold mr-1">View</span>
          {(['solid', 'xray', 'cutaway'] as ViewMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              className={`px-2 py-0.5 text-[10px] border ${
                viewMode === m
                  ? 'bg-[var(--a-accent)] text-[var(--t-inverse)] border-[var(--a-accent)]'
                  : 'bg-[var(--s-canvas)] text-[var(--t-secondary)] border-[var(--b-control)] hover:border-[var(--a-accent)]'
              }`}
            >
              {m === 'xray' ? 'X-Ray' : m === 'cutaway' ? 'Cut' : 'Solid'}
            </button>
          ))}
        </div>

        {/* Cutaway angle */}
        {viewMode === 'cutaway' && (
          <div className="flex items-center gap-1">
            <span className="text-[var(--t-muted)] text-[10px]">Angle</span>
            <input
              type="range" min={0} max={360} value={clipAngle}
              onChange={(e) => setClipAngle(Number(e.target.value))}
              className="w-20 accent-[var(--a-accent)]"
            />
            <span className="text-[var(--t-muted)] text-[10px] w-6">{clipAngle}°</span>
          </div>
        )}

        <div className="w-px h-4 bg-[var(--b-soft)]" />

        {/* Field selector */}
        <div className="flex items-center gap-1">
          <span className="text-[var(--t-secondary)] text-[10px] font-bold">Field</span>
          <select
            value={field}
            onChange={(e) => setField(e.target.value as FieldId)}
            className="bg-[var(--s-canvas)] border border-[var(--b-control)] text-[var(--t-primary)] text-[10px] px-1 py-0.5 outline-none"
          >
            {availableFields.map((f) => (
              <option key={f} value={f}>{FIELD_LABELS[f]}</option>
            ))}
          </select>
        </div>

        {field !== 'none' && (
          <div className="flex items-center gap-1">
            <span className="text-[var(--t-muted)] text-[10px]">Map</span>
            <select
              value={colorMap}
              onChange={(e) => setColorMap(e.target.value as ColorMap)}
              className="bg-[var(--s-canvas)] border border-[var(--b-control)] text-[var(--t-primary)] text-[10px] px-1 py-0.5 outline-none"
            >
              <option value="jet">Jet</option>
              <option value="viridis">Viridis</option>
              <option value="thermal">Thermal</option>
              <option value="coolwarm">Cool-Warm</option>
            </select>
          </div>
        )}

        <div className="w-px h-4 bg-[var(--b-soft)]" />

        {/* Casing toggle */}
        <label className="flex items-center gap-1 text-[var(--t-secondary)] text-[10px]">
          <input type="checkbox" checked={showCasing} onChange={(e) => setShowCasing(e.target.checked)} />
          Casing
        </label>
      </div>

      {/* Color legend */}
      {field !== 'none' && fieldData && (
        <div className="px-2">
          <ColorLegend
            min={fieldData.min}
            max={fieldData.max}
            unit={fieldData.unit}
            colorMap={colorMap}
            label={FIELD_LABELS[field]}
          />
        </div>
      )}

      {/* Transport controls */}
      <div className="flex items-center space-x-3">
        <button
          onClick={() => (progress >= 1 ? (setProgress(0), setPlaying(true)) : setPlaying(!playing))}
          className="bg-[var(--a-accent-dim)] border border-[var(--a-accent)] text-white px-3 py-1.5 font-bold flex items-center hover:bg-[var(--a-accent)]"
        >
          {playing ? <Pause className="w-3 h-3 mr-1" /> : <Play className="w-3 h-3 mr-1" />}
          {playing ? 'Pause' : 'Play'}
        </button>
        <button
          onClick={reset}
          className="border border-[var(--b-control)] text-[var(--t-secondary)] px-2 py-1.5 flex items-center hover:border-[var(--b-control)]"
        >
          <Reset className="w-3 h-3" />
        </button>
        <input
          type="range" min={0} max={1} step={0.002} value={progress}
          onChange={(e) => { setPlaying(false); setProgress(parseFloat(e.target.value)); }}
          className="flex-1 accent-[var(--a-accent)]"
        />
        <span className="text-[var(--t-muted)] text-[10px] w-16 text-right">
          {timeline ? `${current.t.toFixed(2)}s` : `${(progress * 100).toFixed(0)}%`}
        </span>
      </div>

      {/* Readout grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 border border-[var(--b-soft)] p-3 bg-[var(--s-canvas)]">
        <div>
          <p className="text-[var(--t-secondary)] text-[10px]">{timeline ? 'Time' : 'Burn progress'}</p>
          <p className="text-[var(--t-primary)]">
            {timeline ? `${current.t.toFixed(3)} s` : `${(progress * 100).toFixed(0)} %`}
          </p>
        </div>
        <div>
          <p className="text-[var(--t-secondary)] text-[10px]">Web regressed</p>
          <p className="text-[var(--t-primary)]">
            {(current.y * 1000).toFixed(2)} / {(web * 1000).toFixed(2)} mm
          </p>
        </div>
        <div>
          <p className="text-[var(--t-secondary)] text-[10px]">Burning area</p>
          <p className="text-[var(--a-accent)]">{(analyticAb * 1e4).toFixed(1)} cm²</p>
        </div>
        <div>
          <p className="text-[var(--t-secondary)] text-[10px]">Port area</p>
          <p className="text-[var(--a-accent)]">{(analyticPort * 1e4).toFixed(2)} cm²</p>
        </div>
        {current.row && (
          <>
            <div>
              <p className="text-[var(--t-secondary)] text-[10px]">Chamber pressure</p>
              <p className="text-[var(--a-accent)]">{(current.row.Pc / 1e6).toFixed(2)} MPa</p>
            </div>
            <div>
              <p className="text-[var(--t-secondary)] text-[10px]">Thrust</p>
              <p className="text-[var(--a-accent)]">{(current.row.Thrust / 1000).toFixed(2)} kN</p>
            </div>
            <div>
              <p className="text-[var(--t-secondary)] text-[10px]">Mass flow</p>
              <p className="text-[var(--t-primary)]">{current.row.MassFlow.toFixed(3)} kg/s</p>
            </div>
            <div>
              <p className="text-[var(--t-secondary)] text-[10px]">Port mass flux</p>
              <p className="text-[var(--t-primary)]">{current.row.PortMassFlux.toFixed(1)} kg/m²s</p>
            </div>
          </>
        )}
      </div>

      {/* Probe points panel */}
      {probes.length > 0 && (
        <div className="border border-[var(--b-soft)] bg-[var(--s-canvas)] p-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[var(--t-secondary)] text-[10px] font-bold">Probe Points</span>
            <button
              onClick={() => setProbes([])}
              className="text-[var(--t-muted)] hover:text-[var(--sem-danger)] text-[10px] flex items-center gap-0.5"
            >
              <Trash className="w-2.5 h-2.5" /> Clear all
            </button>
          </div>
          <div className="space-y-1">
            {probes.map((p, i) => (
              <div key={p.id} className="flex items-center gap-2 text-[10px]">
                <span className="text-[var(--sem-danger)] font-bold w-4">#{p.id}</span>
                <span className="text-[var(--t-muted)]">{p.meshType}</span>
                <span className="text-[var(--t-muted)]">z={((p.axialFrac - 0.5) * grain.length * 1000).toFixed(1)}mm</span>
                <span className="text-[var(--t-primary)] font-mono">
                  {field !== 'none' ? probeValues[i] : '—'}
                </span>
                <button
                  onClick={() => setProbes((prev) => prev.filter((x) => x.id !== p.id))}
                  className="text-[var(--t-muted)] hover:text-[var(--sem-danger)] ml-auto"
                >
                  <Close className="w-2.5 h-2.5" />
                </button>
              </div>
            ))}
          </div>
          {field === 'none' && (
            <p className="text-[var(--t-muted)] text-[9px] mt-1">Select a field to see probe values.</p>
          )}
        </div>
      )}

      {!timeline && (
        <p className="text-[var(--t-muted)] text-[10px]">
          Scrubbing web directly. Run a simulation to scrub in time with pressure and thrust data.
          {!stations && ' Use the quasi-1-D solver for axial field visualization.'}
        </p>
      )}
    </div>
  );
}

export default GrainBurn3D;
