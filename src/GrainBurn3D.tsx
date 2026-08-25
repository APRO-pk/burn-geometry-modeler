import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Play, Pause, RotateCcw } from 'lucide-react';
import { outlineAt } from './grainOutline';
import type { GrainOutline, Pt } from './grainOutline';
import { grainFromConfig, burnoutWeb } from './surrogate/features';
import type { SurrogateGrain } from './surrogate/features';
import type { SimulationResult } from './engine';

/*
 * Live 3-D burn-back view.
 *
 * The grain is drawn as a solid: the casing disc with the port cut out of it,
 * extruded along the motor axis. As the web regresses the port grows, the solid
 * thins, and BATES additionally shortens because its end faces burn too.
 *
 * The shape comes from src/grainOutline.ts, which offsets the port polygon --
 * which is what burn-back physically is -- so what is on screen is the real
 * regressed geometry rather than an artist's impression of one.
 *
 * When a simulation has been run the scrubber is in TIME and the web comes from
 * the solver's own `y` column, so the animation plays the motor that was
 * actually simulated. Without results it falls back to scrubbing the web
 * directly, which still works for a grain that has never been run.
 */

/** Web positions are snapped to this many steps so meshes can be cached. */
const WEB_STEPS = 240;

const PROPELLANT = 0x9a8f7a;
const CASING = 0x4a5568;

interface Props {
  grain: SurrogateGrain;
  /** Solver output, if a simulation has been run. Enables the time scrubber. */
  results: SimulationResult[];
  /** Extra rows the caller wants shown alongside the geometry readout. */
  addLog?: (msg: string) => void;
}

// --- mesh building ---------------------------------------------------------

function ringToShapePath(ring: Pt[]): THREE.Path {
  const p = new THREE.Path();
  p.moveTo(ring[0].x, ring[0].y);
  for (let i = 1; i < ring.length; i++) p.lineTo(ring[i].x, ring[i].y);
  p.closePath();
  return p;
}

/**
 * Build the propellant solid for one outline.
 *
 * The grain is the casing disc minus the port, so the port rings become HOLES
 * in the outer shape -- which is also why a Rod & Tube rod has to be a separate
 * solid: it is propellant that sits inside the void, not part of the ring.
 */
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
    // A degenerate outline near burnout can defeat triangulation; drawing
    // nothing for one frame is better than tearing down the scene.
    return null;
  }
}

// --- component -------------------------------------------------------------

export function GrainBurn3D({ grain, results }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    grainMesh: THREE.Mesh | null;
    casing: THREE.Mesh;
    dispose: () => void;
    /**
     * Re-frame the camera around a motor of this radius and length.
     *
     * Declared here rather than cast on at the two call sites: it is assigned
     * once the renderer exists, so it is genuinely optional, and saying so lets
     * the optional-call operator do the checking instead of `as any`.
     */
    frame?: (r: number, len: number) => void;
  } | null>(null);

  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1 through the burn
  const [showCasing, setShowCasing] = useState(true);

  const web = useMemo(() => burnoutWeb(grainFromConfig(grain)), [grain]);

  /**
   * Web positions sampled from the solver, so the animation follows the real
   * regression history -- which is not linear in time, since burn rate tracks
   * chamber pressure.
   */
  const timeline = useMemo(() => {
    const usable = results.filter((r) => Number.isFinite(r.y));
    if (usable.length < 2) return null;
    return {
      duration: usable[usable.length - 1].Time,
      rows: usable,
    };
  }, [results]);

  /** Current web, and the solver row it came from if there is one. */
  const current = useMemo(() => {
    if (!timeline) return { y: progress * web, row: null as SimulationResult | null, t: 0 };
    const idx = Math.min(
      timeline.rows.length - 1,
      Math.max(0, Math.round(progress * (timeline.rows.length - 1)))
    );
    const row = timeline.rows[idx];
    return { y: row.y, row, t: row.Time };
  }, [timeline, progress, web]);

  /** Snap so identical webs reuse a cached mesh instead of retriangulating. */
  const quantWeb = Math.round((current.y / Math.max(web, 1e-9)) * WEB_STEPS) / WEB_STEPS;

  const outline = useMemo(
    () => outlineAt(grain, quantWeb * web),
    [grain, quantWeb, web]
  );

  // --- scene setup (once) ---
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0a);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 100);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(1, 1.2, 1.6);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x88bbff, 0.5);
    rim.position.set(-1.5, -0.6, -1);
    scene.add(rim);

    const casing = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 1, 96, 1, true),
      new THREE.MeshStandardMaterial({
        color: CASING,
        metalness: 0.7,
        roughness: 0.45,
        transparent: true,
        opacity: 0.18,
        side: THREE.DoubleSide,
      })
    );
    casing.rotation.x = Math.PI / 2;
    scene.add(casing);

    // Hand-rolled orbit: drag to rotate, wheel to dolly. Two handlers beat
    // pulling in a controls addon for this.
    let theta = 0.9;
    let phi = 1.15;
    let radius = 1;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const applyCamera = () => {
      camera.position.set(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.sin(theta)
      );
      camera.lookAt(0, 0, 0);
    };

    const onDown = (e: PointerEvent) => {
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
      try {
        renderer.domElement.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      radius = Math.min(6 * radius0, Math.max(0.3 * radius0, radius * (1 + e.deltaY * 0.001)));
      applyCamera();
    };

    let radius0 = 1;
    const el = renderer.domElement;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });

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

    sceneRef.current = {
      renderer,
      scene,
      camera,
      grainMesh: null,
      casing,
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
    };

    // Frame the motor: expose a setter the geometry effect can call.
    sceneRef.current.frame = (r: number, len: number) => {
      radius0 = Math.max(r * 4.2, len * 1.9);
      radius = radius0;
      applyCamera();
      camera.near = radius0 / 200;
      camera.far = radius0 * 20;
      camera.updateProjectionMatrix();
    };

    applyCamera();
    return () => {
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []);

  // --- swap the grain mesh whenever the outline changes ---
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
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          color: PROPELLANT,
          roughness: 0.85,
          metalness: 0.05,
          side: THREE.DoubleSide,
        })
      );
      s.scene.add(mesh);
      s.grainMesh = mesh;
    }

    s.casing.visible = showCasing;
    s.casing.scale.set(outline.outerRadius, grain.length, outline.outerRadius);
    s.frame?.(outline.outerRadius, grain.length);
  }, [outline, showCasing, grain.length]);

  // --- playback ---
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const step = () => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      setProgress((p) => {
        // Real burns are ~1-3 s; play them over ~6 s so the shape is readable.
        const next = p + dt / 6;
        if (next >= 1) {
          setPlaying(false);
          return 1;
        }
        return next;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const reset = useCallback(() => {
    setPlaying(false);
    setProgress(0);
  }, []);

  const eng = useMemo(() => grainFromConfig(grain), [grain]);
  const analyticAb = eng.get_burning_area(current.y);
  const analyticPort = eng.get_port_area(current.y);
  const drawnAb = outline.perimeter * outline.length;
  const endArea =
    grain.kind === 'BATES'
      ? 2 * Math.PI * (grain.outer_radius ** 2 - Math.min(grain.inner_radius + current.y, grain.outer_radius) ** 2)
      : 0;
  const lateral = Math.max(analyticAb - endArea, 0);
  const abGap = lateral > 0 ? (drawnAb - lateral) / lateral : 0;

  return (
    <div className="w-full max-w-5xl space-y-3 mt-4 text-xs font-mono">
      <div
        ref={mountRef}
        className="w-full h-[420px] border border-[var(--b-soft)] rounded bg-[var(--s-canvas)] relative overflow-hidden"
      >
        <div className="absolute top-2 left-2 z-10 text-[var(--t-muted)] text-[10px] pointer-events-none">
          drag to rotate &middot; scroll to zoom
        </div>
        {outline.burnedOut && (
          <div className="absolute inset-0 flex items-center justify-center text-[var(--sem-warn)] text-sm pointer-events-none">
            GRAIN CONSUMED
          </div>
        )}
      </div>

      {/* --- transport --- */}
      <div className="flex items-center space-x-3">
        <button
          onClick={() => (progress >= 1 ? (setProgress(0), setPlaying(true)) : setPlaying(!playing))}
          className="bg-[var(--sem-warn)] text-[var(--t-inverse)] px-3 py-1.5 font-bold rounded flex items-center hover:brightness-110"
        >
          {playing ? <Pause className="w-3 h-3 mr-1" /> : <Play className="w-3 h-3 mr-1" />}
          {playing ? 'Pause' : 'Play'}
        </button>
        <button
          onClick={reset}
          className="border border-[var(--b-control)] text-[var(--t-secondary)] px-2 py-1.5 rounded flex items-center hover:border-[var(--b-control)]"
        >
          <RotateCcw className="w-3 h-3" />
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.002}
          value={progress}
          onChange={(e) => {
            setPlaying(false);
            setProgress(parseFloat(e.target.value));
          }}
          className="flex-1 accent-[var(--sem-warn)]"
        />
        <label className="flex items-center space-x-1 text-[var(--t-secondary)] whitespace-nowrap">
          <input
            type="checkbox"
            checked={showCasing}
            onChange={(e) => setShowCasing(e.target.checked)}
          />
          <span>casing</span>
        </label>
      </div>

      {/* --- readout --- */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 border border-[var(--b-soft)] rounded p-3 bg-[var(--s-canvas)]">
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
          <p className="text-[var(--t-secondary)] text-[10px]">Burning area (drawn)</p>
          <p className="text-[var(--sem-warn)]">{(drawnAb * 1e4).toFixed(1)} cm²</p>
        </div>
        <div>
          <p className="text-[var(--t-secondary)] text-[10px]">Port area (drawn)</p>
          <p className="text-[var(--sem-warn)]">{(outline.area * 1e4).toFixed(2)} cm²</p>
        </div>
        {current.row && (
          <>
            <div>
              <p className="text-[var(--t-secondary)] text-[10px]">Chamber pressure</p>
              <p className="text-[var(--sem-ok)]">{(current.row.Pc / 1e6).toFixed(2)} MPa</p>
            </div>
            <div>
              <p className="text-[var(--t-secondary)] text-[10px]">Thrust</p>
              <p className="text-[var(--sem-ok)]">{(current.row.Thrust / 1000).toFixed(2)} kN</p>
            </div>
            <div>
              {/* BATES is the only geometry with burning END FACES, and a
                  cross-section cannot show them -- so its solver total is
                  legitimately above the drawn lateral figure. Labelling it
                  stops that reading as a discrepancy. */}
              <p className="text-[var(--t-secondary)] text-[10px]">
                Solver burning area{endArea > 0 ? ' (incl. ends)' : ''}
              </p>
              <p className="text-[var(--t-primary)]">
                {(analyticAb * 1e4).toFixed(1)} cm²
                {endArea > 0 && (
                  <span className="text-[var(--t-muted)]"> · {(lateral * 1e4).toFixed(1)} lateral</span>
                )}
              </p>
            </div>
            <div>
              <p className="text-[var(--t-secondary)] text-[10px]">Solver port area</p>
              <p className="text-[var(--t-primary)]">{(analyticPort * 1e4).toFixed(2)} cm²</p>
            </div>
          </>
        )}
      </div>

      {/*
        The drawn shape is exact offsetting; the solver holds an analytic model.
        Where they differ the number the solver used is the approximate one, and
        saying so is more useful than quietly showing two figures that disagree.
      */}
      {Math.abs(abGap) > 0.02 && !outline.burnedOut && (
        <div className="border border-[var(--sem-warn)] bg-[var(--sem-warn-wash)] rounded p-2 text-[10px] text-[var(--sem-warn)] leading-snug">
          At this web the drawn burning area is {(abGap * 100).toFixed(1)}% from the value the
          solver used ({(lateral * 1e4).toFixed(1)} cm² lateral). The shape here comes from exact
          polygon offsetting; <span className="text-[var(--sem-warn)]">{grain.kind}</span>&apos;s analytic
          model in engine.ts is an approximation — for Finocyl the fin slots are treated as sharp
          rectangles, which a real burn rounds off. The picture is the accurate one.
        </div>
      )}

      {!timeline && (
        <p className="text-[var(--t-muted)] text-[10px]">
          Scrubbing web directly. Run a simulation to scrub in time instead, with pressure and
          thrust at each instant.
        </p>
      )}
    </div>
  );
}

export default GrainBurn3D;
