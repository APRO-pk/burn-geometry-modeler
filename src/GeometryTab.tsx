import React from 'react';
import type { SimulationResult } from './engine';

export interface GeometryTabProps {
  grainType: string;
  outerRadius: number;
  innerRadius: number;
  valleyRadius: number;
  tipRadius: number;
  numPoints: number;
  offset: number;
  finDepth: number;
  finWidth: number;
  rodRadius: number;
  dxfData: { areaTable: number[]; dx: number } | null;
  results: SimulationResult[];
  visualizerIndex: number;
  onVisualizerIndexChange: (i: number) => void;
}

export function GeometryTab({
  grainType,
  outerRadius,
  innerRadius,
  valleyRadius,
  tipRadius,
  numPoints,
  offset,
  finDepth,
  finWidth,
  rodRadius,
  dxfData,
  results,
  visualizerIndex,
  onVisualizerIndexChange,
}: GeometryTabProps) {
  const currentY =
    results.length > 0 && visualizerIndex < results.length
      ? results[visualizerIndex].y
      : 0;

  return (
    <div
      className="chart-frame"
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div className="chart-caption">Grain cross-section regression</div>
      <div className="w-full h-full flex items-center justify-center p-8">
        <svg
          viewBox="0 0 200 200"
          className="w-full h-full max-w-[500px] max-h-[500px] bg-[var(--s-sunken)] border border-[var(--b-strong)]"
        >
          <circle cx="100" cy="100" r={95} fill="var(--b-control)" />
          {grainType === 'BATES' || grainType === 'Tubular' ? (
            <circle
              cx="100"
              cy="100"
              r={(Math.min(outerRadius, Math.max(0, innerRadius + currentY)) / outerRadius) * 95}
              fill="var(--s-canvas)"
            />
          ) : grainType === 'RodAndTube' ? (
            <>
              <circle
                cx="100"
                cy="100"
                r={(Math.min(outerRadius, Math.max(0, innerRadius + currentY)) / outerRadius) * 95}
                fill="var(--s-canvas)"
              />
              {rodRadius - currentY > 0 && (
                <circle
                  cx="100"
                  cy="100"
                  r={(Math.max(0, rodRadius - currentY) / outerRadius) * 95}
                  fill="var(--b-control)"
                />
              )}
            </>
          ) : grainType === 'MoonBurner' ? (
            <circle
              cx={100 + (offset / outerRadius) * 95}
              cy="100"
              r={
                (Math.min(outerRadius + offset, Math.max(0, innerRadius + currentY)) / outerRadius) *
                95
              }
              fill="var(--s-canvas)"
            />
          ) : grainType === 'Finocyl' ? (
            <FinocylPath
              outerRadius={outerRadius}
              innerRadius={innerRadius}
              finWidth={finWidth}
              finDepth={finDepth}
              numPoints={numPoints}
              currentY={currentY}
            />
          ) : grainType === 'CustomDXF' && dxfData ? (
            <circle
              cx="100"
              cy="100"
              r={
                (Math.sqrt(
                  dxfData.areaTable[
                    Math.min(Math.floor(currentY / dxfData.dx), dxfData.areaTable.length - 1)
                  ] / Math.PI,
                ) /
                  outerRadius) *
                95
              }
              fill="var(--s-canvas)"
            />
          ) : (
            <StarPath
              outerRadius={outerRadius}
              valleyRadius={valleyRadius}
              tipRadius={tipRadius}
              numPoints={numPoints}
              currentY={currentY}
            />
          )}
        </svg>
      </div>
      <div className="absolute bottom-4 left-4 right-4 flex flex-col space-y-2 bg-[var(--s-canvas)] p-3 border border-[var(--b-soft)]">
        <div className="flex justify-between text-[var(--c-6)] text-[10px] px-2">
          <span>Burn Area: {(results[visualizerIndex]?.Ab * 10000 || 0).toFixed(1)} cm²</span>
          <span>Port Area: {(results[visualizerIndex]?.PortArea * 10000 || 0).toFixed(1)} cm²</span>
        </div>
        <div className="flex items-center space-x-2">
          <span className="text-[var(--c-6)] text-[10px] w-16">
            T: {results[visualizerIndex]?.Time.toFixed(2) || '0.00'}s
          </span>
          <input
            type="range"
            min="0"
            max={Math.max(0, results.length - 1)}
            value={visualizerIndex}
            onChange={(e) => onVisualizerIndexChange(Number(e.target.value))}
            className="flex-1 accent-[var(--c-6)]"
            disabled={results.length === 0}
          />
          <span className="text-[var(--c-6)] text-[10px] w-16 text-right">
            W: {(currentY * 1000).toFixed(1)}mm
          </span>
        </div>
      </div>
    </div>
  );
}

function FinocylPath({
  outerRadius,
  innerRadius,
  finWidth,
  finDepth,
  numPoints,
  currentY,
}: {
  outerRadius: number;
  innerRadius: number;
  finWidth: number;
  finDepth: number;
  numPoints: number;
  currentY: number;
}) {
  const scale = 95 / outerRadius;
  const rc = Math.min(outerRadius * scale, (innerRadius + currentY) * scale);
  const hw = (finWidth / 2.0 + currentY) * scale;
  const td = (finDepth - finWidth / 2.0) * scale;

  if (rc >= outerRadius * scale)
    return <path d="M 5,100 A 95,95 0 1,1 195,100 A 95,95 0 1,1 5,100 Z" fill="var(--s-canvas)" />;

  let path = '';
  for (let i = 0; i < numPoints; i++) {
    const angle = (i * 2 * Math.PI) / numPoints;
    const nx = Math.sin(angle);
    const ny = -Math.cos(angle);
    const tx = -ny;
    const ty = nx;
    const cx = 100 + nx * td;
    const cy = 100 + ny * td;
    const p1x = 100 + nx * rc + tx * hw;
    const p1y = 100 + ny * rc + ty * hw;
    const p2x = cx + tx * hw;
    const p2y = cy + ty * hw;
    const p3x = cx - tx * hw;
    const p3y = cy - ty * hw;
    const p4x = 100 + nx * rc - tx * hw;
    const p4y = 100 + ny * rc - ty * hw;

    if (i === 0) path += `M ${p1x} ${p1y} `;
    else path += `L ${p1x} ${p1y} `;
    path += `L ${p2x} ${p2y} `;
    path += `A ${hw} ${hw} 0 0 1 ${p3x} ${p3y} `;
    path += `L ${p4x} ${p4y} `;

    const nextAngle = ((i + 1) * 2 * Math.PI) / numPoints;
    const nextNx = Math.sin(nextAngle);
    const nextNy = -Math.cos(nextAngle);
    const nextTx = -nextNy;
    const nextTy = nextNx;
    const nextP1x = 100 + nextNx * rc + nextTx * hw;
    const nextP1y = 100 + nextNy * rc + nextTy * hw;
    path += `A ${rc} ${rc} 0 0 1 ${nextP1x} ${nextP1y} `;
  }

  return <path d={path + 'Z'} fill="var(--s-canvas)" />;
}

function StarPath({
  outerRadius,
  valleyRadius,
  tipRadius,
  numPoints,
  currentY,
}: {
  outerRadius: number;
  valleyRadius: number;
  tipRadius: number;
  numPoints: number;
  currentY: number;
}) {
  const scale = 95 / outerRadius;
  const rOuter = Math.min(outerRadius, valleyRadius + currentY) * scale;
  const rInner = Math.min(outerRadius, tipRadius + currentY) * scale;
  let path = '';
  for (let i = 0; i < numPoints * 2; i++) {
    const radius = i % 2 === 0 ? rInner : rOuter;
    const angle = (i * Math.PI) / numPoints;
    const px = 100 + radius * Math.sin(angle);
    const py = 100 - radius * Math.cos(angle);
    path += i === 0 ? `M ${px} ${py} ` : `L ${px} ${py} `;
  }

  return <path d={path + 'Z'} fill="var(--s-canvas)" />;
}
