const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

if (!code.includes('import { parse } from "url";')) {
  code = code.replace(
    'import type { WebSocket, WebSocketServer } from "ws";',
    'import type { WebSocket, WebSocketServer } from "ws";\nimport { parse } from "url";'
  );
}
code = code.replace(
  'handle(guarded, res);',
  'handle(guarded as any, res as any);'
);

fs.writeFileSync('server.ts', code);
