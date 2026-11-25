// QuizBuzz — serveur de buzzer pour quiz, sans aucune dépendance (Node.js 18+)
// Lancement : node server.js   (options : PORT=3000 ADMIN_PIN=1234)
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = +process.env.PORT || 3000;
const PIN = String(process.env.ADMIN_PIN || Math.floor(1000 + Math.random() * 9000));
const PAGE = path.join(__dirname, 'public', 'index.html');

// ---------- état de la partie ----------
const G = {
  round: 1,
  open: true,
  autolock: true,
  order: [],      // [{id, team, num}] dans l'ordre d'arrivée au serveur
  out: [],        // ids des équipes qui ont donné une mauvaise réponse à cette question
  scores: {},     // { "nom en minuscules": points }
  teams: {},      // id -> {id, team, num, online, lastSeen}
};
const clients = new Set(); // {res, role, id}

const clean = s => [...String(s ?? '')]
  .filter(ch => { const k = ch.codePointAt(0); return k >= 32 && !(k >= 127 && k <= 159) && !(k >= 0x200b && k <= 0x200f) && !(k >= 0x2028 && k <= 0x202e) && !(k >= 0x2060 && k <= 0x206f) && k !== 0xfeff; })
  .join('').trim().slice(0, 24);
const key = t => t.toLowerCase();
const teamList = () => Object.values(G.teams).sort((a, b) => a.num - b.num);
const takenNums = exceptId => new Set(teamList().filter(t => t.id !== exceptId).map(t => t.num));

function playerView(id) {
  const mine = G.teams[id];
  return { round: G.round, open: G.open, order: G.order, out: G.out, you: id,
    me: mine ? { team: mine.team, num: mine.num } : null,
    taken: teamList().filter(t => t.id !== id).map(t => t.num) };
}
function adminView() {
  return { round: G.round, open: G.open, autolock: G.autolock, order: G.order, out: G.out,
    scores: G.scores, teams: teamList() };
}
function send(c) {
  const data = c.role === 'admin' ? adminView() : playerView(c.id);
  c.res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function broadcast() { for (const c of clients) send(c); }
function nextRound() { G.round++; G.order = []; G.out = []; G.open = true; }

// équipes déconnectées depuis plus de 2 minutes : on libère leur couleur (les points restent)
setInterval(() => {
  const now = Date.now(); let changed = false;
  for (const t of Object.values(G.teams)) if (!t.online && now - t.lastSeen > 120000) { delete G.teams[t.id]; changed = true; }
  if (changed) broadcast();
  for (const c of clients) c.res.write(': ping\n\n');
}, 15000);

// ---------- HTTP ----------
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise(resolve => {
    let b = ''; req.on('data', d => { b += d; if (b.length > 8000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(PAGE).pipe(res);
  }

  // flux temps réel (Server-Sent Events)
  if (req.method === 'GET' && url.pathname === '/events') {
    const role = url.searchParams.get('pin') === PIN ? 'admin' : 'player';
    if (url.searchParams.has('pin') && role !== 'admin') return json(res, 403, { error: 'Code animateur incorrect' });
    const id = String(url.searchParams.get('id') || '').slice(0, 40);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    const c = { res, role, id };
    clients.add(c);
    if (role === 'player' && G.teams[id]) { G.teams[id].online = true; broadcast(); } else send(c);
    req.on('close', () => {
      clients.delete(c);
      if (role === 'player' && G.teams[id] && ![...clients].some(x => x.id === id)) {
        G.teams[id].online = false; G.teams[id].lastSeen = Date.now(); broadcast();
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/join') {
    const b = await body(req);
    const id = String(b.id || '').slice(0, 40), team = clean(b.team), num = +b.num;
    if (!id || !team) return json(res, 400, { error: "Donne un nom à ton équipe." });
    if (!(num >= 1 && num <= 12)) return json(res, 400, { error: 'Choisis une couleur.' });
    if (takenNums(id).has(num)) return json(res, 409, { error: "Cette couleur vient d'être prise, choisis-en une autre." });
    if (teamList().some(t => t.id !== id && key(t.team) === key(team))) return json(res, 409, { error: 'Ce nom d\'équipe est déjà utilisé.' });
    G.teams[id] = { id, team, num, online: [...clients].some(x => x.id === id), lastSeen: Date.now() };
    broadcast();
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/leave') {
    const b = await body(req);
    delete G.teams[String(b.id || '')]; broadcast();
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/buzz') {
    const b = await body(req);
    const t = G.teams[String(b.id || '')];
    if (!t) return json(res, 404, { error: 'Équipe inconnue, inscris-toi à nouveau.' });
    if (G.open && !G.order.some(o => o.id === t.id) && !G.out.includes(t.id)) {
      G.order.push({ id: t.id, team: t.team, num: t.num });
      if (G.order.length === 1 && G.autolock) G.open = false;
      broadcast();
    }
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin') {
    const b = await body(req);
    if (String(b.pin) !== PIN) return json(res, 403, { error: 'Code animateur incorrect' });
    switch (b.action) {
      case 'check': return json(res, 200, { ok: true });
      case 'next': nextRound(); break;
      case 'toggle': G.open = !G.open; break;
      case 'autolock': G.autolock = !!b.value; break;
      case 'good': { const w = G.order[0]; if (w) { G.scores[key(w.team)] = (G.scores[key(w.team)] || 0) + 1; nextRound(); } break; }
      case 'bad': { const w = G.order.shift(); if (w) { G.out.push(w.id); if (!G.order.length) G.open = true; } break; }
      case 'score': { const k = key(clean(b.team)); if (k) G.scores[k] = (G.scores[k] || 0) + (b.d > 0 ? 1 : -1); break; }
      case 'kick': delete G.teams[String(b.id || '')]; break;
      case 'reset-scores': G.scores = {}; break;
      case 'restore-scores': {
        const src = b.scores && typeof b.scores === 'object' ? b.scores : {};
        G.scores = {};
        for (const [k, v] of Object.entries(src).slice(0, 50)) { const kk = key(clean(k)); if (kk && Number.isFinite(+v)) G.scores[kk] = Math.trunc(+v); }
        break;
      }
      default: return json(res, 400, { error: 'Action inconnue' });
    }
    broadcast();
    return json(res, 200, { ok: true });
  }

  res.writeHead(404); res.end('Introuvable');
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log('\n  ==== QuizBuzz est lancé ====\n');
  console.log('  Sur cet ordinateur :      http://localhost:' + PORT);
  for (const ip of ips) console.log('  Pour les téléphones :     http://' + ip + ':' + PORT);
  console.log('\n  Code animateur :          ' + PIN);
  console.log('\n  (les téléphones doivent être sur le même Wi-Fi que cet ordinateur)');
  console.log('  Pour arrêter : ferme cette fenêtre ou fais Ctrl+C\n');
});
