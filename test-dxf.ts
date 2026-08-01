import DxfParser from 'dxf-parser';
const parser = new DxfParser();
const content = `
0
SECTION
  2
ENTITIES
  0
CIRCLE
 10
0.0
 20
0.0
 40
10.0
  0
ENDSEC
  0
EOF
`;
const dxf = parser.parseSync(content);
console.log(JSON.stringify(dxf, null, 2));
