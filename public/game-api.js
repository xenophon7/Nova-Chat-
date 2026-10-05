/*
 * game-api.js — présence des joueurs d'Energy Arena (Nova/Axess Chat)
 * Routes :
 *   POST /api/game/ping    (joueur connecté)  { state, wave, score, character }
 *   POST /api/game/leave   (joueur connecté)
 *   GET  /api/admin/players (admin)           liste des joueurs en jeu
 * Un joueur est considéré "en ligne dans le jeu" s'il a envoyé un signal il y a moins de 20 s.
 */
const crypto = require('crypto');
const players = new Map();
const TTL = 20000;
const rooms = new Map();
const RTTL = 6000, MAXP = 8;
const STATES = ['menu', 'playing', 'pause', 'between', 'over'];
const num = (v, max) => Math.max(0, Math.min(max, Number(v) || 0)) | 0;

function prune() {
  const now = Date.now();
  for (const [id, p] of players) if (now - p.lastSeen > TTL) players.delete(id);
}

module.exports = async function gameApi(ctx, req, res, u) {
  const { me, adminMe, out, jsonBody } = ctx;

  if (req.method === 'POST' && u.pathname === '/api/game/ping') {
    const x = me(req);
    if (!x) { out(res, 401, { error: 'Non connecté' }); return true; }
    let d = {};
    try { d = await jsonBody(req, 1e4); } catch {}
    const now = Date.now();
    let p = players.get(x.id);
    if (!p || now - p.lastSeen > TTL) p = { id: x.id, since: now };
    p.name = x.name;
    p.state = STATES.includes(d.state) ? d.state : 'menu';
    p.wave = num(d.wave, 9999);
    p.score = num(d.score, 1e9);
    p.character = String(d.character || '').slice(0, 20);
    p.lastSeen = now;
    players.set(x.id, p);
    out(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'POST' && u.pathname === '/api/game/leave') {
    const x = me(req);
    if (x) players.delete(x.id);
    out(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'GET' && u.pathname === '/api/admin/players') {
    if (!adminMe(req)) { out(res, 401, { error: 'ADMIN_AUTH_REQUIRED' }); return true; }
    prune();
    const list = [...players.values()]
      .map(p => ({ id: p.id, name: p.name, state: p.state, wave: p.wave, score: p.score, character: p.character, since: p.since }))
      .sort((a, b) => (b.state === 'playing') - (a.state === 'playing') || b.score - a.score);
    out(res, 200, {
      players: list,
      inGame: list.filter(p => p.state !== 'menu').length,
      total: list.length
    });
    return true;
  }
  // ---------- Multijoueur : salles ----------
  if (req.method === 'POST' && u.pathname === '/api/room/create') {
    const x = me(req);
    if (!x) { out(res, 401, { error: 'Non connecté' }); return true; }
    let d = {}; try { d = await jsonBody(req, 1e4); } catch {}
    const now = Date.now();
    for (const [k, r] of rooms) { for (const [i, p] of r.players) if (now - p.last > RTTL) r.players.delete(i); if (!r.players.size && now - r.created > 600000) rooms.delete(k); }
    const id = crypto.randomBytes(3).toString('hex').toUpperCase();
    const room = { id, mode: d.mode === 'bots' ? 'bots' : 'pvp', created: now, players: new Map(), seq: 0, bullets: [] };
    rooms.set(id, room);
    out(res, 200, { ok: true, id, mode: room.mode });
    return true;
  }
  if (req.method === 'POST' && u.pathname === '/api/room/sync') {
    const x = me(req);
    if (!x) { out(res, 401, { error: 'Non connecté' }); return true; }
    let d; try { d = await jsonBody(req, 2e4); } catch { out(res, 400, { error: 'Données invalides' }); return true; }
    const r = rooms.get(String(d.room || '').toUpperCase());
    if (!r) { out(res, 404, { error: 'Partie introuvable ou terminée' }); return true; }
    const now = Date.now();
    for (const [i, p] of r.players) if (now - p.last > RTTL) r.players.delete(i);
    let p = r.players.get(x.id);
    if (!p) {
      if (r.players.size >= MAXP) { out(res, 403, { error: 'Partie pleine' }); return true; }
      p = { id: x.id, frags: 0 }; r.players.set(x.id, p);
    }
    const s = d.s || {};
    p.name = x.name; p.x = num(s.x, 3000); p.y = num(s.y, 2000); p.a = Number(s.a) || 0;
    p.hp = num(s.hp, 999); p.ch = String(s.ch || '').slice(0, 12); p.al = !!s.al; p.last = now;
    const k = d.kb && r.players.get(String(d.kb));
    if (k && k.id !== x.id && now - (p.lastKb || 0) > 500) { k.frags++; p.lastKb = now; }
    if (Array.isArray(d.b)) for (const b of d.b.slice(0, 10)) {
      if (Array.isArray(b) && b.length === 4) { r.seq++; r.bullets.push({ q: r.seq, o: x.id, x: +b[0] || 0, y: +b[1] || 0, vx: +b[2] || 0, vy: +b[3] || 0, t: now }); }
    }
    r.bullets = r.bullets.filter(b => now - b.t < 3000);
    const since = Number(d.since) || 0;
    out(res, 200, {
      mode: r.mode, seq: r.seq, me: x.id,
      players: [...r.players.values()].map(q => ({ id: q.id, name: q.name, x: q.x, y: q.y, a: q.a, hp: q.hp, ch: q.ch, al: q.al, frags: q.frags })),
      bullets: r.bullets.filter(b => b.q > since && b.o !== x.id).map(b => ({ o: b.o, x: b.x, y: b.y, vx: b.vx, vy: b.vy }))
    });
    return true;
  }
  return false;
};

/*
 * Injection automatique des scripts dans index.html et admin.html
 * (évite d'avoir à modifier ces deux fichiers à la main).
 */
module.exports.inject = function (urlPath, buf) {
  var tag = urlPath === '/admin.html' ? '<script src="/admin-players.js"></script>'
    : (urlPath === '/' || urlPath === '/index.html') ? '<script src="/game-launcher.js"></script>' : null;
  if (!tag) return buf;
  var s = buf.toString('utf8');
  if (s.indexOf(tag) !== -1) return buf;
  var i = s.lastIndexOf('</body>');
  if (i < 0) return buf;
  return Buffer.from(s.slice(0, i) + tag + s.slice(i), 'utf8');
};
