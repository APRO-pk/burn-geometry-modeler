export function exportBurnsimXML(config: any): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<BurnSimProject>
  <Motor>
    <Length>${config.length}</Length>
    <Diameter>${config.outerRadius * 2}</Diameter>
    <ThroatDiameter>${config.throatDiameter}</ThroatDiameter>
    <ExpansionRatio>${config.expansionRatio}</ExpansionRatio>
  </Motor>
  <Propellant>
    <Density>${config.density}</Density>
    <a_0>${config.a}</a_0>
    <n_0>${config.n}</n_0>
    <MolWt>${config.molWeight}</MolWt>
    <Gamma>${config.gamma}</Gamma>
    <FlameTemp>${config.flameTemp}</FlameTemp>
  </Propellant>
  <Grain>
    <Type>${config.grainType}</Type>
    <InnerRadius>${config.innerRadius}</InnerRadius>
    <NumSegments>${config.numSegments}</NumSegments>
  </Grain>
</BurnSimProject>`;
}

export function parseBurnsimXML(xml: string): any {
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
   
   const parsed: any = {};
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
