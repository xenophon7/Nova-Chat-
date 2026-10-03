/* NovaChat — correctif frontend complémentaire
   Le serveur l'injecte automatiquement dans index.html.
*/
(function(){
  const $=(s)=>document.querySelector(s);
  const colors=['#1677ff','#2563eb','#00a884','#10b981','#14b8a6','#06b6d4','#0ea5e9','#7c4dff','#8b5cf6','#a855f7','#e91e63','#f43f5e','#f44336','#f97316','#ff9800','#eab308','#84cc16','#22c55e','#64748b','#111827'];
  function style(){if($('#novaPatchStyle'))return;const s=document.createElement('style');s.id='novaPatchStyle';s.textContent=`#novaOnlineCount{margin:0 14px 10px;padding:10px 13px;border-radius:14px;background:#e9f8ee;color:#176b35;font-weight:700;font-size:14px}.nova-security{margin:14px 0;padding:16px;border-radius:18px;background:var(--card,#fff);border:1px solid #dbe3ee;box-shadow:0 5px 18px #0001}.nova-security h3{margin:0 0 10px}.nova-security input{display:block;width:100%;padding:12px;margin:8px 0;border:1px solid #ccd5df;border-radius:12px}.nova-security button{padding:11px 14px;border:0;border-radius:12px;background:var(--primary,#1677ff);color:#fff;font-weight:700}.nova-palette{display:flex;flex-wrap:wrap;gap:9px;margin-top:10px}.nova-color{width:30px;height:30px;border-radius:50%;border:3px solid transparent;padding:0}.nova-color.active{border-color:#111;transform:scale(1.1)}body.nova-dark{background:#10131a!important;color:#eef2f7!important}body.nova-dark .nova-security,body.nova-dark .card,body.nova-dark .panel,body.nova-dark .settings-card{background:#171b24!important;color:#eef2f7!important;border-color:#2b3442!important}body.nova-dark input{background:#11151d!important;color:#fff!important;border-color:#364152!important}`;document.head.appendChild(s)}
  function authFix(){
    const auth=$('#auth'),app=$('#app');
    if(!auth||!app)return;
    fetch('/api/me',{cache:'no-store',credentials:'same-origin'}).then(r=>r.json()).then(d=>{
      if(!d.user){window.me=null;app.classList.add('hidden');auth.classList.remove('hidden');}
    }).catch(()=>{});
  }
  function online(){
    let b=$('#novaOnlineCount'), c=$('#contacts'); if(!c)return;
    if(!b){b=document.createElement('div');b.id='novaOnlineCount';b.textContent='🟢 Utilisateurs en ligne : …';c.parentNode.insertBefore(b,c)}
    fetch('/api/users',{cache:'no-store',credentials:'same-origin'}).then(r=>r.json()).then(d=>{let n=Number(d.otherOnlineCount??Math.max(0,Number(d.onlineCount||0)-1));b.textContent='🟢 '+n+' autre'+(n>1?'s':'')+' utilisateur'+(n>1?'s':'')+' en ligne'}).catch(()=>{});
  }
  function settingsRoot(){return $('#settings')||$('#settingsPanel')||$('#settingsMenu')||document.querySelector('[data-settings]')||document.querySelector('.settings');}
  function settings(){
    const root=settingsRoot(); if(!root||$('#novaSecurity'))return;
    const box=document.createElement('section');box.id='novaSecurity';box.className='nova-security';
    box.innerHTML='<h3>🔐 Sécurité</h3><p>Modifier le mot de passe de ton compte.</p><input id="novaOldPw" type="password" placeholder="Mot de passe actuel" autocomplete="current-password"><input id="novaNewPw" type="password" placeholder="Nouveau mot de passe" autocomplete="new-password"><input id="novaConfirmPw" type="password" placeholder="Confirmer le nouveau mot de passe" autocomplete="new-password"><button id="novaPwBtn">Modifier le mot de passe</button><div id="novaPwMsg" style="margin-top:8px;font-size:13px"></div><h3 style="margin-top:18px">🌙 Apparence</h3><button id="novaDarkBtn" type="button"></button><div style="margin-top:14px">Couleur</div><div id="novaPalette" class="nova-palette"></div>';
    root.appendChild(box);
    const dark=localStorage.getItem('novaDark')==='1'; document.body.classList.toggle('nova-dark',dark); $('#novaDarkBtn').textContent=dark?'☀️ Mode clair':'🌙 Mode sombre';
    $('#novaDarkBtn').onclick=()=>{const v=!document.body.classList.contains('nova-dark');document.body.classList.toggle('nova-dark',v);localStorage.setItem('novaDark',v?'1':'0');$('#novaDarkBtn').textContent=v?'☀️ Mode clair':'🌙 Mode sombre'};
    const pal=$('#novaPalette'),saved=localStorage.getItem('novaColor'); colors.forEach(c=>{const b=document.createElement('button');b.className='nova-color'+(c===saved?' active':'');b.style.background=c;b.title=c;b.onclick=()=>{document.documentElement.style.setProperty('--primary',c);localStorage.setItem('novaColor',c);pal.querySelectorAll('.nova-color').forEach(x=>x.classList.remove('active'));b.classList.add('active')};pal.appendChild(b)}); if(saved)document.documentElement.style.setProperty('--primary',saved);
    $('#novaPwBtn').onclick=async()=>{const msg=$('#novaPwMsg');const currentPassword=$('#novaOldPw').value,newPassword=$('#novaNewPw').value,confirmPassword=$('#novaConfirmPw').value;msg.textContent='';if(!currentPassword||newPassword.length<4){msg.textContent='Remplis correctement les champs.';return}if(newPassword!==confirmPassword){msg.textContent='Les deux nouveaux mots de passe ne correspondent pas.';return}try{const r=await fetch('/api/profile/password',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword,newPassword,confirmPassword})});const d=await r.json();if(!r.ok)throw Error(d.error||'Erreur');msg.textContent='Mot de passe modifié avec succès.';$('#novaOldPw').value='';$('#novaNewPw').value='';$('#novaConfirmPw').value=''}catch(e){msg.textContent=e.message==='INVALID_CURRENT_PASSWORD'?'Mot de passe actuel incorrect.':e.message}};
  }
  function start(){style();authFix();online();settings();setInterval(online,5000);setInterval(authFix,5000);setInterval(settings,1500)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();