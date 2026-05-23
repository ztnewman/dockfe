const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3737', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BUFFER = 512 * 1024 * 1024;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: MAX_BUFFER }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

async function listRunningIds() {
  const out = await run('docker', ['ps', '-q', '--no-trunc']);
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

async function inspectAll(ids) {
  if (!ids.length) return [];
  const out = await run('docker', ['inspect', ...ids]);
  return JSON.parse(out);
}

function parsePublishedPorts(networkSettings) {
  const ports = (networkSettings && networkSettings.Ports) || {};
  const out = [];
  const seen = new Set();
  for (const [portProto, bindings] of Object.entries(ports)) {
    if (!bindings) continue;
    const [containerStr, proto] = portProto.split('/');
    if (proto !== 'tcp') continue;
    const container = parseInt(containerStr, 10);
    for (const b of bindings) {
      const host = parseInt(b.HostPort, 10);
      if (!host) continue;
      const key = `${host}/${container}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ host, container });
    }
  }
  return out.sort((a, b) => a.host - b.host);
}

function extractTraefik(labels) {
  if (labels['traefik.enable'] === 'false') return [];
  const routers = {};
  for (const key of Object.keys(labels)) {
    const m = key.match(/^traefik\.http\.routers\.([^.]+)\.(.+)$/);
    if (!m) continue;
    const [, name, attr] = m;
    if (!routers[name]) routers[name] = {};
    routers[name][attr] = labels[key];
  }
  const out = [];
  for (const r of Object.values(routers)) {
    if (!r.rule) continue;
    const hosts = [...r.rule.matchAll(/Host(?:Header)?\(`([^`]+)`\)/g)].map(x => x[1]);
    if (!hosts.length) continue;
    const ep = (r.entrypoints || '').toLowerCase();
    const isHttps = r.tls === 'true' || /websecure|https|443/.test(ep);
    const scheme = isHttps ? 'https' : 'http';
    for (const h of hosts) {
      out.push({ url: `${scheme}://${h}`, label: h, source: 'traefik' });
    }
  }
  return out;
}

function extractCaddy(labels) {
  const out = [];
  for (const key of Object.keys(labels)) {
    if (key !== 'caddy' && !key.match(/^caddy(\.[0-9]+)?$/)) continue;
    const val = labels[key];
    if (!val) continue;
    const hosts = val.split(/[,\s]+/).map(s => s.trim()).filter(s => /^[a-z0-9][a-z0-9.\-]*\.[a-z0-9.\-]+$/i.test(s));
    for (const h of hosts) {
      out.push({ url: `https://${h}`, label: h, source: 'caddy' });
    }
  }
  return out;
}

function extractNginxProxy(labels) {
  if (!labels.VIRTUAL_HOST) return [];
  const hosts = labels.VIRTUAL_HOST.split(',').map(s => s.trim()).filter(Boolean);
  const hasTls = !!labels.LETSENCRYPT_HOST || (labels.VIRTUAL_PROTO || '').toLowerCase() === 'https';
  const scheme = hasTls ? 'https' : (labels.VIRTUAL_PROTO || 'http');
  return hosts.map(h => ({ url: `${scheme}://${h}`, label: h, source: 'nginx-proxy' }));
}

function deriveSlug(image) {
  let s = (image || '').split('@')[0].split('/').pop().split(':')[0].toLowerCase();
  s = s.replace(/[-_](alpine|slim|latest|stable|bookworm|bullseye|buster|jammy|focal|noble|distroless).*$/, '');
  return s;
}

function dedupEndpoints(endpoints) {
  const seen = new Set();
  return endpoints.filter(e => {
    const k = e.url || `:${e.port.host}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function shapeContainer(inspect) {
  const labels = inspect.Config && inspect.Config.Labels || {};
  const composeProject = labels['com.docker.compose.project'] || null;
  const composeService = labels['com.docker.compose.service'] || null;
  const name = (inspect.Name || '').replace(/^\//, '');
  const image = (inspect.Config && inspect.Config.Image) || '';

  const proxied = [
    ...extractTraefik(labels),
    ...extractCaddy(labels),
    ...extractNginxProxy(labels),
  ];
  const published = parsePublishedPorts(inspect.NetworkSettings).map(p => ({
    port: p,
    label: `:${p.host}`,
    source: 'port',
  }));

  const endpoints = dedupEndpoints(proxied.length ? proxied : published);

  return {
    id: (inspect.Id || '').slice(0, 12),
    name,
    service: composeService,
    project: composeProject,
    image,
    slug: deriveSlug(image),
    iconOverride: labels['dockfe.icon'] || null,
    status: (inspect.State && inspect.State.Status) || '',
    endpoints,
  };
}

async function getContainers() {
  const ids = await listRunningIds();
  const inspects = await inspectAll(ids);
  return inspects
    .map(shapeContainer)
    .filter(c => c.endpoints.length > 0)
    .sort((a, b) => {
      const pa = a.project || '';
      const pb = b.project || '';
      if (pa !== pb) return pa.localeCompare(pb);
      return a.name.localeCompare(b.name);
    });
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
      const containers = await getContainers();
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
