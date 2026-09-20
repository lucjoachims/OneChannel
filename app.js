// =====================================================================
//  OneChannel — logique client
//  Tout le contenu est chiffré ici, avant d'atteindre le serveur.
//  Le serveur ne reçoit que channel_id (un hash) et de l'illisible.
//  AUCUNE notification système n'est jamais demandée ni émise.
//  Pas d'installation (aucun service worker, aucun manifest).
// =====================================================================

const API = 'api/index.php';
const POLL_MS = 1500;            // cadence de rafraîchissement (fil visible)
const TYPING_PING_MS = 2000;     // « j'écris » envoyé au plus toutes les 2 s
const enc = new TextEncoder();
const dec = new TextDecoder();
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- petits utilitaires ------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

let toastTimer = null;
function toast(msg, danger = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (danger ? ' danger' : ''); t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// Normalisation de la clé : insensible casse/accents/espaces multiples.
function normKey(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
          .trim().toLowerCase().replace(/\s+/g, ' ');
}
const normCode = (s) => s.trim().toUpperCase();

// Code aléatoire sans caractères ambigus (0/O, 1/I/L).
function genCode(len = 5) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const arr = crypto.getRandomValues(new Uint8Array(len));
  return [...arr].map(x => alphabet[x % alphabet.length]).join('');
}

// ---- dérivations -------------------------------------------------------
async function deriveChannelId(key, code) {
  const data = enc.encode('canal|v1|chan|' + normKey(key) + '|' + normCode(code));
  return hex(await crypto.subtle.digest('SHA-256', data));
}

async function deriveCryptoKey(key, code) {
  const secret = normKey(key) + '|' + normCode(code);
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
  const salt = await crypto.subtle.digest('SHA-256', enc.encode('canal|v1|salt|' + secret));
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

// ---- chiffrement -------------------------------------------------------
async function encText(ck, str) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, ck, enc.encode(str));
  return { iv: b64(iv), ciphertext: b64(ct) };
}
async function decText(ck, ivB64, ctB64) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(ivB64) }, ck, unb64(ctB64));
  return dec.decode(pt);
}
async function encBytes(ck, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, ck, bytes);
  return { iv: b64(iv), bytes: new Uint8Array(ct) };
}
async function decBytes(ck, ivB64, ctBytes) {
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(ivB64) }, ck, ctBytes));
}

// ---- appels API --------------------------------------------------------
async function apiPost(action, body) {
  try {
    const r = await fetch(`${API}?action=${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  } catch (e) { return { status: 0, data: {} }; }
}
async function apiGet(action, params) {
  try {
    const q = new URLSearchParams(params).toString();
    const r = await fetch(`${API}?action=${action}&${q}`, { cache: 'no-store' });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  } catch (e) { return { status: 0, data: {} }; }
}

// ---- jeton d'appareil (scellement) ------------------------------------
// Seule chose persistée : un secret par canal. Rien de déchiffrable.
function getDeviceToken(channelId) {
  const k = 'dt:' + channelId;
  let t = localStorage.getItem(k);
  if (!t) { t = hex(crypto.getRandomValues(new Uint8Array(32))); localStorage.setItem(k, t); }
  return t;
}

// ---- état courant ------------------------------------------------------
let S = null;          // session active
let pollTimer = null;
let pulling = false;
const blobUrls = new Set();

function resetSession() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  for (const u of blobUrls) URL.revokeObjectURL(u);
  blobUrls.clear();
  closeLightbox();
  S = null;
}

// =====================================================================
//  Écrans
// =====================================================================
function show(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.hidden = true);
  $('#' + screenId).hidden = false;
}

function showStart() { resetSession(); clearThreadView(); show('start'); }

function showCreate() {
  show('create');
  $('#create-admin').value = '';
  $('#create-key').value = '';
  $('#create-result').hidden = true;
  $('#create-strength').textContent = '';
  $('#create-error').textContent = '';
  $('#create-generate').disabled = false;
  $('#create-admin').focus();
}

function showOpen() {
  show('open');
  $('#open-key').value = '';
  $('#open-code').value = '';
  $('#open-error').textContent = '';
  $('#open-key').focus();
}

// ---- force de la clé (indicatif) --------------------------------------
function keyStrength(k) {
  const n = normKey(k);
  if (n.length < 4) return { ok: false, label: 'Trop courte (4 caractères minimum).' };
  const trivial = ['1234', '0000', 'azerty', 'qwerty', 'password', 'motdepasse', 'admin'];
  if (trivial.includes(n)) return { ok: false, label: 'Trop devinable, change-la.' };
  if (n.length < 8) return { ok: true, label: 'Correcte. Le code complète la sécurité.' };
  return { ok: true, label: 'Bonne clé.' };
}

// =====================================================================
//  CREATE (admin)
// =====================================================================
$('#create-key').addEventListener('input', (e) => {
  const s = keyStrength(e.target.value);
  $('#create-strength').textContent = e.target.value ? s.label : '';
  $('#create-strength').className = 'hint ' + (s.ok ? 'ok' : 'warn');
});

$('#create-generate').addEventListener('click', async () => {
  const key = $('#create-key').value;
  const s = keyStrength(key);
  if (!$('#create-admin').value) {
    $('#create-strength').textContent = 'Le mot de passe administrateur est requis.';
    $('#create-strength').className = 'hint warn'; $('#create-admin').focus(); return;
  }
  if (!s.ok) { $('#create-strength').textContent = s.label; $('#create-strength').className = 'hint warn'; return; }
  const code = genCode(5);
  $('#out-key').textContent = key.trim();
  $('#out-code').textContent = code;
  $('#create-result').hidden = false;
  $('#create-error').textContent = '';
  $('#create-generate').disabled = true;
  $('#create-result').dataset.key = key;
  $('#create-result').dataset.code = code;
});

$('#create-confirm').addEventListener('click', async () => {
  const key = $('#create-result').dataset.key;
  const code = $('#create-result').dataset.code;
  const admin = $('#create-admin').value;
  const channelId = await deriveChannelId(key, code);
  const ck = await deriveCryptoKey(key, code);
  const token = getDeviceToken(channelId);
  const err = $('#create-error');
  err.textContent = '';

  let res = await apiPost('create', { channel_id: channelId, device_token: token, admin_password: admin });
  if (res.status === 403) { err.textContent = 'Mot de passe administrateur incorrect.'; return; }
  if (res.status === 429) { err.textContent = 'Trop de tentatives. Réessaie plus tard.'; return; }
  if (res.status === 409) {
    // Canal déjà là (re-création depuis le même appareil) : on rejoint.
    res = await apiPost('join', { channel_id: channelId, device_token: token });
  }
  if (res.status !== 200 || !res.data.ok) { err.textContent = 'Impossible de créer le canal. Réessaie.'; return; }
  enterThread({ channelId, ck, token, role: res.data.role, closedSeq: res.data.closed_seq || 0 });
});

// =====================================================================
//  OPEN
// =====================================================================
$('#open-confirm').addEventListener('click', async () => {
  const key = $('#open-key').value;
  const code = $('#open-code').value;
  const err = $('#open-error');
  err.textContent = '';
  if (!normKey(key) || !normCode(code)) { err.textContent = 'Entre la clé et le code.'; return; }
  const channelId = await deriveChannelId(key, code);
  const ck = await deriveCryptoKey(key, code);
  const token = getDeviceToken(channelId);

  const res = await apiPost('join', { channel_id: channelId, device_token: token });
  if (res.status === 404) { err.textContent = 'Clé ou code incorrect.'; return; }
  if (res.status === 403) { err.textContent = 'Ce canal est déjà complet (2 appareils).'; return; }
  if (res.status === 429) { err.textContent = 'Trop de tentatives. Réessaie plus tard.'; return; }
  if (res.status !== 200 || !res.data.ok) { err.textContent = 'Échec de connexion.'; return; }

  enterThread({ channelId, ck, token, role: res.data.role, closedSeq: res.data.closed_seq || 0 });
});
$('#open-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#open-confirm').click(); });

// =====================================================================
//  THREAD (le fil)
// =====================================================================
function clearThreadView() {
  document.querySelectorAll('#thread-list .msg:not(.typing)').forEach(el => el.remove());
  $('#thread-empty').hidden = false;
  $('#typing').hidden = true;
  setPresence('', '…');
}

function setPresence(state, label) {
  $('#presence-dot').className = 'dot ' + state;
  $('#thread-status').textContent = label;
}

function enterThread(sess) {
  S = { ...sess, afterId: 0, lastReadSent: 0, lastTypingPing: 0, typingSent: false, typingPromise: null, peerMaxId: 0 };
  show('thread');
  clearThreadView();
  $('#msg-input').value = '';
  $('#msg-input').focus();
  pull(); // premier tirage immédiat
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') pull();
  }, POLL_MS);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S) pull();
});

async function pull() {
  if (!S || pulling) return;
  pulling = true;
  try {
    const res = await apiGet('messages', { channel_id: S.channelId, device_token: S.token, after: S.afterId });
    if (!S || res.status !== 200 || !res.data.ok) {
      if (S && res.status === 403) { toast('Accès au canal refusé.', true); showStart(); }
      return;
    }
    const d = res.data;

    // Détection d'une PANIQUE distante : on vide la vue.
    if (d.closed_seq > S.closedSeq) {
      S.closedSeq = d.closed_seq;
      S.afterId = 0; S.peerMaxId = 0; S.lastReadSent = 0;
      clearThreadView();
      toast('Le fil a été effacé.', true);
      return;
    }

    // Nouveaux messages.
    for (const m of d.messages) {
      S.afterId = Math.max(S.afterId, m.id);
      await renderMessage(m);
    }

    // Retire ce qui n'existe plus côté serveur (expiré, brûlé).
    const alive = new Set(d.alive);
    document.querySelectorAll('#thread-list .msg[data-id]').forEach(el => {
      if (!alive.has(+el.dataset.id)) removeMessageEl(el);
    });
    if (!document.querySelector('#thread-list .msg[data-id]:not(.gone)')) $('#thread-empty').hidden = false;

    // Présence + frappe.
    const p = d.peer;
    if (!d.sealed || !p.present) setPresence('', 'En attente de l’autre…');
    else if (p.typing) setPresence('typing', 'écrit…');
    else if (p.online) setPresence('online', 'en ligne');
    else setPresence('', 'hors ligne');
    const typingEl = $('#typing');
    const wasHidden = typingEl.hidden;
    typingEl.hidden = !(p.present && p.typing);
    if (wasHidden && !typingEl.hidden) scrollBottom();

    // Accusés sur mes messages.
    updateTicks(p.delivered_id, p.read_id);

    // Je lis ce que je vois → « lu ».
    if (document.visibilityState === 'visible' && S.peerMaxId > S.lastReadSent) {
      S.lastReadSent = S.peerMaxId;
      apiPost('read', { channel_id: S.channelId, device_token: S.token, up_to: S.peerMaxId });
    }
  } finally { pulling = false; }
}

function updateTicks(deliveredId, readId) {
  document.querySelectorAll('#thread-list .msg.mine[data-id] .ticks').forEach(t => {
    const id = +t.closest('.msg').dataset.id;
    let st = 'sent', label = '✓', title = 'Envoyé';
    if (id <= readId)           { st = 'read';      label = '✓✓'; title = 'Lu'; }
    else if (id <= deliveredId) { st = 'delivered'; label = '✓✓'; title = 'Reçu'; }
    if (!t.classList.contains(st)) { t.className = 'ticks ' + st; t.textContent = label; t.title = title; }
  });
}

function removeMessageEl(el) {
  if (el.classList.contains('gone')) return;
  el.classList.add('gone');
  setTimeout(() => el.remove(), REDUCED ? 0 : 380);
}

function scrollBottom() {
  const list = $('#thread-list');
  requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
}

function fmtTime(ts) {
  const d = ts ? new Date(ts * 1000) : new Date();
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

// ---- effet « déchiffrement » -------------------------------------------
// Le texte reçu apparaît d'abord brouillé, puis chaque caractère se
// stabilise. Purement cosmétique : le vrai déchiffrement a déjà eu lieu.
const GLYPHS = '!<>-_\\/[]{}=+*^?#%&@$~0123456789ABCDEFXYZabcdefkmnpqrstuvwxyz§µ¤';
function morphIn(el, text) {
  if (REDUCED || !text) { el.textContent = text; return; }
  const chars = [...text];
  const total = Math.min(1500, 450 + chars.length * 18);
  const plan = chars.map((c, i) => ({
    c, keep: /\s/.test(c),
    at: (i / chars.length) * total * 0.7 + Math.random() * total * 0.3,
  }));
  el.classList.add('morph');
  const start = performance.now();
  let lastFrame = 0;
  function frame(now) {
    const t = now - start;
    if (now - lastFrame < 38 && t < total) { requestAnimationFrame(frame); return; }
    lastFrame = now;
    const frag = document.createDocumentFragment();
    let run = '';
    const flush = () => { if (run) { frag.appendChild(document.createTextNode(run)); run = ''; } };
    let done = true;
    for (const p of plan) {
      if (p.keep || t >= p.at) run += p.c;
      else {
        done = false; flush();
        const g = document.createElement('span'); g.className = 'g';
        g.textContent = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
        frag.appendChild(g);
      }
    }
    flush();
    el.replaceChildren(frag);
    if (!done) requestAnimationFrame(frame);
    else { el.classList.remove('morph'); el.textContent = text; }
  }
  requestAnimationFrame(frame);
}

// ---- rendu d'un message --------------------------------------------------
const ICON_DOC = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
const ICON_IMG = '<svg viewBox="0 0 24 24" width="18" height="18"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="10" r="1.8" fill="currentColor"/><path d="m4 17 5-5 4 4 3-3 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';

async function renderMessage(m) {
  if (document.querySelector(`#thread-list .msg[data-id="${m.id}"]`)) return;
  $('#thread-empty').hidden = true;
  const mine = (m.sender === S.role);
  if (!mine) S.peerMaxId = Math.max(S.peerMaxId, m.id);

  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (mine ? 'mine' : 'theirs');
  wrap.dataset.id = m.id;

  try {
    if (m.type === 'text') {
      const txt = await decText(S.ck, m.iv, m.ciphertext);
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      if (mine) bubble.textContent = txt; else morphIn(bubble, txt);
      wrap.appendChild(bubble);
    } else if (m.type === 'media') {
      const meta = JSON.parse(await decText(S.ck, m.iv, m.ciphertext));
      wrap.appendChild(mediaBubble(meta, m.id, mine));
    }
  } catch (e) {
    const bubble = document.createElement('div');
    bubble.className = 'bubble error';
    bubble.textContent = '[contenu illisible]';
    wrap.appendChild(bubble);
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  const time = document.createElement('span');
  time.textContent = fmtTime(m.ts);
  meta.appendChild(time);
  if (mine) {
    const ticks = document.createElement('span');
    ticks.className = 'ticks sent'; ticks.textContent = '✓'; ticks.title = 'Envoyé';
    meta.appendChild(ticks);
  }
  wrap.appendChild(meta);

  $('#thread-list').insertBefore(wrap, $('#typing'));
  scrollBottom();
}

// ---- documents : ouverture unique ----------------------------------------
function mediaBubble(meta, id, mine) {
  const bubble = document.createElement('div');
  bubble.className = 'bubble media' + (mine ? '' : ' openable');
  const isImg = meta.kind === 'image';
  bubble.innerHTML = `<span class="ic">${isImg ? ICON_IMG : ICON_DOC}</span>`
    + `<span><span class="nm"></span><span class="st"></span></span>`;
  bubble.querySelector('.nm').textContent = meta.name || (isImg ? 'Image' : 'Document');
  bubble.querySelector('.st').textContent = mine
    ? 'Pas encore ouvert · détruit à l’ouverture'
    : (isImg ? 'Appuyer pour voir · une seule fois' : 'Appuyer pour télécharger · une seule fois');
  if (!mine) bubble.addEventListener('click', () => openMedia(meta, id, bubble), { once: true });
  return bubble;
}

async function openMedia(meta, id, bubble) {
  if (!S) return;
  bubble.classList.remove('openable');
  bubble.classList.add('busy');
  bubble.querySelector('.st').textContent = 'Déchiffrement…';
  try {
    const r = await fetch(`${API}?action=media&channel_id=${S.channelId}&device_token=${S.token}&media_id=${meta.media_id}`, { cache: 'no-store' });
    if (!r.ok) { bubble.querySelector('.st').textContent = 'Document déjà détruit.'; return; }
    const ctBytes = new Uint8Array(await r.arrayBuffer());
    const plain = await decBytes(S.ck, meta.iv, ctBytes);
    const blob = new Blob([plain], { type: meta.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    blobUrls.add(url);

    // Détruit sur le serveur dès l'ouverture : le fichier ne sera plus jamais servi.
    await apiPost('burn', { channel_id: S.channelId, device_token: S.token, message_id: id, media_id: meta.media_id });
    bubble.querySelector('.st').textContent = 'Ouvert · détruit';

    if (meta.kind === 'image') {
      openLightbox(url);
    } else {
      const a = document.createElement('a');
      a.href = url; a.download = meta.name || 'document';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { URL.revokeObjectURL(url); blobUrls.delete(url); }, 60000);
    }
    setTimeout(() => { const el = bubble.closest('.msg'); if (el) removeMessageEl(el); }, 1200);
  } catch (e) {
    bubble.querySelector('.st').textContent = 'Document illisible.';
  } finally { bubble.classList.remove('busy'); }
}

function openLightbox(url) {
  const lb = $('#lightbox');
  $('#lightbox-img').src = url;
  lb.hidden = false;
}
function closeLightbox() {
  const lb = $('#lightbox');
  if (lb.hidden) return;
  const img = $('#lightbox-img');
  const url = img.src;
  img.removeAttribute('src');
  lb.hidden = true;
  if (url.startsWith('blob:')) { URL.revokeObjectURL(url); blobUrls.delete(url); }
}
$('#lightbox-close').addEventListener('click', closeLightbox);
$('#lightbox').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeLightbox(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });

// ---- envoi texte ------------------------------------------------------------
async function sendText() {
  const input = $('#msg-input');
  const txt = input.value.trim();
  if (!txt || !S) return;
  input.value = ''; autoGrow();
  S.typingSent = false;
  const { iv, ciphertext } = await encText(S.ck, txt);
  await S.typingPromise; // un « j'écris » en vol ne doit pas arriver après l'envoi
  const res = await apiPost('send', {
    channel_id: S.channelId, device_token: S.token, type: 'text', iv, ciphertext,
  });
  if (res.status === 200) pull();
  else { input.value = txt; toast('Envoi impossible.', true); }
}
$('#msg-send').addEventListener('click', sendText);
$('#msg-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
});

// « j'écris » — signal léger, jamais plus d'une fois toutes les 2 s.
function autoGrow() {
  const ta = $('#msg-input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(140, ta.scrollHeight) + 'px';
}
$('#msg-input').addEventListener('input', () => {
  autoGrow();
  if (!S) return;
  const has = $('#msg-input').value.length > 0;
  const now = Date.now();
  if (has && now - S.lastTypingPing > TYPING_PING_MS) {
    S.lastTypingPing = now; S.typingSent = true;
    S.typingPromise = apiPost('typing', { channel_id: S.channelId, device_token: S.token, typing: true });
  } else if (!has && S.typingSent) {
    S.typingSent = false; S.lastTypingPing = 0;
    S.typingPromise = apiPost('typing', { channel_id: S.channelId, device_token: S.token, typing: false });
  }
});

// ---- envoi document ----------------------------------------------------------
$('#msg-attach').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !S) return;
  if (file.size > 8 * 1024 * 1024) { toast('Fichier trop lourd (8 Mo max).', true); return; }

  toast('Chiffrement et envoi…');
  const buf = new Uint8Array(await file.arrayBuffer());
  const { iv, bytes } = await encBytes(S.ck, buf);

  // 1) dépôt du blob chiffré
  let upData = {};
  try {
    const up = await fetch(`${API}?action=upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Channel': S.channelId, 'X-Device': S.token, 'X-Iv': iv },
      body: bytes,
    });
    upData = await up.json().catch(() => ({}));
    if (!up.ok || !upData.ok) throw new Error('upload');
  } catch (err) { toast("Échec de l'envoi du document.", true); return; }

  // 2) message référençant le média (métadonnées chiffrées elles aussi)
  const kind = file.type.startsWith('image/') ? 'image' : 'doc';
  const meta = { kind, media_id: upData.media_id, iv, name: file.name, mime: file.type };
  const m = await encText(S.ck, JSON.stringify(meta));
  await apiPost('send', { channel_id: S.channelId, device_token: S.token, type: 'media', iv: m.iv, ciphertext: m.ciphertext });
  pull();
});

// ---- PANIQUE : immédiat, sans confirmation ----------------------------------
$('#thread-panic').addEventListener('click', async () => {
  if (!S) return;
  // Local d'abord (instantané), serveur ensuite (pour l'autre appareil).
  clearThreadView();
  closeLightbox();
  $('#msg-input').value = ''; autoGrow();
  document.body.classList.remove('panic-flash'); void document.body.offsetWidth;
  document.body.classList.add('panic-flash');
  S.afterId = 0; S.peerMaxId = 0; S.lastReadSent = 0;
  const res = await apiPost('close', { channel_id: S.channelId, device_token: S.token });
  if (S && res.data && typeof res.data.closed_seq === 'number') S.closedSeq = res.data.closed_seq;
  toast('Tout a été effacé, des deux côtés.');
});

$('#thread-leave').addEventListener('click', showStart);

// ---- navigation de départ ---------------------------------------------
$('#go-create').addEventListener('click', showCreate);
$('#go-open').addEventListener('click', showOpen);
document.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', showStart));

// Plus d'installation : on désinscrit tout ancien service worker et son cache.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister())).catch(() => {});
  if (window.caches) caches.keys().then(ks => ks.forEach(k => caches.delete(k))).catch(() => {});
}

showStart();
