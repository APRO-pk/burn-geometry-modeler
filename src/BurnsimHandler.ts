import type { DesignSnapshot } from './useDesignHistory';

/**
 * BurnSim (.bsd) interchange.
 *
 * Both directions speak DesignSnapshot -- the same permissive record undo/redo
 * uses. That is deliberate rather than lazy: this file is the boundary with
 * FOREIGN data, so pretending the parsed result is a fully-formed design would
 * be a lie the type system then propagates. Fields are unknown until checked,
 * and applyDesignState checks each one before it reaches state.
 */
/**
 * A snapshot field as a number for the XML, or an empty element if it is
 * missing or not numeric.
 *
 * Writing `undefined` or `NaN` into the file would produce a .bsd that other
 * tools parse as a silent zero -- a zero radius reads as a valid number, so the
 * corruption surfaces far from here. An empty element is at least visibly empty.
 */
const num = (v: unknown, scale = 1): string => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? String(n * scale) : '';
};

export function exportBurnsimXML(config: DesignSnapshot): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<BurnSimProject>
  <Motor>
    <Length>${num(config.length)}</Length>
    <Diameter>${num(config.outerRadius, 2)}</Diameter>
    <ThroatDiameter>${num(config.throatDiameter)}</ThroatDiameter>
    <ExpansionRatio>${num(config.expansionRatio)}</ExpansionRatio>
  </Motor>
  <Propellant>
    <Density>${num(config.density)}</Density>
    <a_0>${num(config.a)}</a_0>
    <n_0>${num(config.n)}</n_0>
    <MolWt>${num(config.molWeight)}</MolWt>
    <Gamma>${num(config.gamma)}</Gamma>
    <FlameTemp>${num(config.flameTemp)}</FlameTemp>
  </Propellant>
  <Grain>
    <Type>${String(config.grainType ?? '')}</Type>
    <InnerRadius>${num(config.innerRadius)}</InnerRadius>
    <NumSegments>${num(config.numSegments)}</NumSegments>
  </Grain>
</BurnSimProject>`;
}

export function parseBurnsimXML(xml: string): DesignSnapshot {
   const parser = new DOMParser();
   const doc = parser.parseFromString(xml, "application/xml");
   
   const safeGet = (tag: string) => {
      const el = doc.getElementsByTagName(tag)[0];
      if (!el || !el.textContent) return undefined;
      const num = parseFloat(el.textContent);
      return isNaN(num) ? undefined : num;
   };
   const safeGetString = (tag: string) => {
      const el = doc.getElementsByTagName(tag)[0];
      return el ? el.textContent : undefined;
   };
   
   const parsed: DesignSnapshot = {};
   const l = safeGet("Length"); if (l !== undefined) parsed.length = l;
   const d = safeGet("Diameter"); if (d !== undefined) parsed.outerRadius = d / 2;
   const td = safeGet("ThroatDiameter"); if (td !== undefined) parsed.throatDiameter = td;
   const er = safeGet("ExpansionRatio"); if (er !== undefined) parsed.expansionRatio = er;
   const den = safeGet("Density"); if (den !== undefined) parsed.density = den;
   const a = safeGet("a_0"); if (a !== undefined) parsed.a = a;
   const n = safeGet("n_0"); if (n !== undefined) parsed.n = n;
   const mw = safeGet("MolWt"); if (mw !== undefined) parsed.molWeight = mw;
   const gm = safeGet("Gamma"); if (gm !== undefined) parsed.gamma = gm;
   const ft = safeGet("FlameTemp"); if (ft !== undefined) parsed.flameTemp = ft;
   const typ = safeGetString("Type"); if (typ) parsed.grainType = typ;
   const ir = safeGet("InnerRadius"); if (ir !== undefined) parsed.innerRadius = ir;
   const ns = safeGet("NumSegments"); if (ns !== undefined) parsed.numSegments = ns;

   return parsed;
}
