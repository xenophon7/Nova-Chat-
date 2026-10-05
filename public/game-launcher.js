/* game-launcher.js — bouton manette 🎮 (en bas à droite) qui ouvre Energy Arena dans le chat */
(function () {
  var fab = document.createElement('button');
  fab.id = 'gameFab'; fab.type = 'button'; fab.title = 'Jouer à Energy Arena'; fab.textContent = '🎮';
  fab.style.cssText = 'position:fixed;right:18px;bottom:calc(24px + env(safe-area-inset-bottom,0px));width:60px;height:60px;border-radius:50%;border:0;background:var(--p,#6d4aff);color:#fff;font-size:28px;line-height:1;box-shadow:0 8px 24px #0005;z-index:35;cursor:pointer;display:none;padding:0';
  document.body.appendChild(fab);

  var overlay = null;

  function openGame(room) {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:200;background:#050b1e';
    var frame = document.createElement('iframe');
    frame.src = room ? '/game.html?room=' + room : '/game.html';
    frame.setAttribute('allow', 'fullscreen; autoplay');
    frame.style.cssText = 'width:100%;height:100%;border:0;display:block';
    var x = document.createElement('button');
    x.type = 'button'; x.textContent = '✕'; x.title = 'Retour au chat';
    x.style.cssText = 'position:absolute;left:50%;bottom:calc(6px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);width:38px;height:38px;border-radius:50%;border:1px solid #00d4ff88;background:#071a3acc;color:#fff;font-size:16px;opacity:.6;z-index:2;padding:0';
    x.onclick = closeGame;
    overlay.appendChild(frame); overlay.appendChild(x);
    document.body.appendChild(overlay);
    try {
      var r = overlay.requestFullscreen ? overlay.requestFullscreen() : null;
      if (r && r.then) r.then(function () { return screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape'); }).catch(function () {});
    } catch (e) {}
  }

  function closeGame() {
    if (!overlay) return;
    overlay.remove(); overlay = null;   // le jeu se ferme et le serveur est prévenu (pagehide)
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
    try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () {}); } catch (e) {}
  }

  fab.onclick = function () { openGame(); };
  window.addEventListener('message', function (e) {
    if (e.origin === location.origin && e.data === 'nova-game-close') closeGame();
  });

  // invitations : ajoute un bouton « Rejoindre » sous les messages contenant un lien de partie
  var msgs = document.getElementById('messages');
  if (msgs) new MutationObserver(function () {
    msgs.querySelectorAll('.bubble:not([data-gl])').forEach(function (b) {
      b.dataset.gl = '1';
      var m = b.textContent.match(/game\.html\?room=([A-F0-9]{6})/);
      if (!m) return;
      var j = document.createElement('button');
      j.type = 'button'; j.textContent = '🎮 Rejoindre la partie';
      j.style.cssText = 'display:block;margin-top:8px;padding:9px 14px;border-radius:12px;border:0;background:#ffe14d;color:#222;font-weight:800;cursor:pointer';
      j.onclick = function () { openGame(m[1]); };
      b.appendChild(j);
    });
  }).observe(msgs, { childList: true });

  setInterval(function () {
    var app = document.getElementById('app'), notify = document.getElementById('notifyPage');
    var show = app && !app.classList.contains('hidden') && !(notify && notify.classList.contains('open')) && !overlay;
    fab.style.display = show ? 'block' : 'none';
  }, 400);
})();
