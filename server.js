const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3737', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');

function dockerPs() {
  return new Promise((resolve, reject) => {
    execFile('docker', ['ps', '--no-trunc', '--format', '{{json .}}'], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
      try {
        resolve(lines.map(l => JSON.parse(l)));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function parsePorts(portStr) {
  if (!portStr) return [];
  const out = [];
  const seen = new Set();
  for (const raw of portStr.split(',')) {
    const p = raw.trim();
    const m = p.match(/(?:(\d+\.\d+\.\d+\.\d+)|\[?::\]?):(\d+)->(\d+)\/(tcp|udp)/);
    if (!m) continue;
    if (m[4] !== 'tcp') continue;
    const bind = m[1] || '::';
    const host = parseInt(m[2], 10);
    const container = parseInt(m[3], 10);
    const key = `${host}/${container}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ bind, host, container });
  }
  return out.sort((a, b) => a.host - b.host);
}

function deriveSlug(image) {
  let s = image.split('@')[0].split('/').pop().split(':')[0].toLowerCase();
  s = s.replace(/[-_](alpine|slim|latest|stable|bookworm|bullseye|buster|jammy|focal|noble|distroless).*$/, '');
  return s;
}

function serveStatic(req, res) {
  const url = req.url.split('?')[0];
  const rel = url === '/' ? '/index.html' : url;
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(full).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css':  'text/css; charset=utf-8',
      '.js':   'text/javascript; charset=utf-8',
      '.svg':  'image/svg+xml',
      '.png':  'image/png',
      '.ico':  'image/x-icon',
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/containers')) {
    try {
      const raw = await dockerPs();
      const containers = raw.map(c => {
        const ports = parsePorts(c.Ports);
        return {
          id: c.ID.slice(0, 12),
          name: (c.Names || '').split(',')[0],
          image: c.Image || '',
          slug: deriveSlug(c.Image || ''),
          status: c.Status || '',
          state: c.State || '',
          created: c.CreatedAt || '',
          ports,
        };
      }).filter(c => c.ports.length > 0)
        .sort((a, b) => a.name.localeCompare(b.name));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ containers, syncedAt: new Date().toISOString() }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`dockfe listening → http://localhost:${PORT}`);
});
