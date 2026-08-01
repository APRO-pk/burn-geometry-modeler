import DxfParser from 'dxf-parser';
import * as ClipperLib from 'clipper-lib';

export interface DXFData {
  polygons: ClipperLib.Path[]; // multiple closed paths are possible
  // We'll calculate lookup tables for regression
  regressionTable: { y: number, area: number, perim: number }[];
}

const SCALE = 1000000.0;

function parseDXF(dxfContent: string): ClipperLib.Path[] {
  const parser = new DxfParser();
  const dxf = parser.parseSync(dxfContent);
  const paths: ClipperLib.Path[] = [];

  // Very basic extraction - we look for Entities that can form polygons
  // Usually users provide LINEs, LWPOLYLINEs, CIRCLEs, ARC
  return paths;
}

export function processDXFForGrain(dxfContent: string, maxWeb: number, steps: number = 200) {

}
