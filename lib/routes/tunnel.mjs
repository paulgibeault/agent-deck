// lib/routes/tunnel.mjs — heal the open-act tunnel to the model host
// (scripts/heal-tunnel.sh); the exit code says how it went.
import path from 'node:path';
import { spawn } from 'node:child_process';

export default function routes({ send, root }) {
  return [{
    method: 'POST', path: '/api/tunnel/heal',
    async handler(req, res) {
      const child = spawn('/bin/sh', [path.join(root, 'scripts', 'heal-tunnel.sh')], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { out += d; });
      const code = await new Promise(r => { child.on('error', () => r(-1)); child.on('close', r); });
      return send(res, 200, { ok: code === 0, code, output: out.trim() });
    },
  }];
}
