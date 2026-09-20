// =====================================================================
//  Canal privé 1:1 — logique client
//  Tout le contenu est chiffré ici, avant d'atteindre le serveur.
//  Le serveur ne reçoit que channel_id (un hash) et de l'illisible.
//  AUCUNE notification système n'est jamais demandée ni émise.
// =====================================================================

const API = 'api/index.php';
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- petits utilitaires ------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// Normalisation de la clé : insensible casse/accents/espaces multiples.
function normKey(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
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
  const r = await fetch(`${API}?action=${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function apiGet(action, params) {
  const q = new URLSearchParams(params).toString();
  const r = await fetch(`${API}?action=${action}&${q}`);
  return { status: r.status, data: await r.json().catch(() => ({})) };
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
let S = null;       // session active
let pollTimer = null;

function resetSession() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  S = null;
}

// =====================================================================
//  Écrans
// =====================================================================
function show(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.hidden = true);
  $('#' + screenId).hidden = false;
}

function showStart() { resetSession(); show('start'); }

function showCreate() {
  show('create');
  $('#create-key').value = '';
  $('#create-result').hidden = true;
  $('#create-strength').textContent = '';
  $('#create-generate').disabled = false;
}

function showOpen() {
  show('open');
  $('#open-key').value = '';
  $('#open-code').value = '';
  $('#open-error').textContent = '';
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
//  CREATE
// =====================================================================
$('#create-key').addEventListener('input', (e) => {
  const s = keyStrength(e.target.value);
  $('#create-strength').textContent = e.target.value ? s.label : '';
  $('#create-strength').className = 'hint ' + (s.ok ? 'ok' : 'warn');
});

$('#create-generate').addEventListener('click', async () => {
  const key = $('#create-key').value;
  const s = keyStrength(key);
  if (!s.ok) { $('#create-strength').textContent = s.label; $('#create-strength').className = 'hint warn'; return; }
  const code = genCode(5);
  $('#out-key').textContent = key.trim();
  $('#out-code').textContent = code;
  $('#create-result').hidden = false;
  $('#create-generate').disabled = true;
  $('#create-result').dataset.key = key;
  $('#create-result').dataset.code = code;
});

$('#create-confirm').addEventListener('click', async () => {
  const key = $('#create-result').dataset.key;
  const code = $('#create-result').dataset.code;
  const channelId = await deriveChannelId(key, code);
  const ck = await deriveCryptoKey(key, code);
  const token = getDeviceToken(channelId);

  let res = await apiPost('create', { channel_id: channelId, device_token: token });
  if (res.status === 409) {
    // Canal déjà là (re-création depuis le même appareil) : on rejoint.
    res = await apiPost('join', { channel_id: channelId, device_token: token });
  }
  if (res.status !== 200 || !res.data.ok) {
    alert("Impossible de créer le canal. Réessaie."); return;
  }
  enterThread({ channelId, ck, token, role: res.data.role,
                closedSeq: res.data.closed_seq || 0 });
});

// =====================================================================
//  OPEN
// =====================================================================
$('#open-confirm').addEventListener('click', async () => {
  const key = $('#open-key').value;
  const code = $('#open-code').value;
  $('#open-error').textContent = '';
  if (!normKey(key) || !normCode(code)) {
    $('#open-error').textContent = 'Entre la clé et le code.'; return;
  }
  const channelId = await deriveChannelId(key, code);
  const ck = await deriveCryptoKey(key, code);
  const token = getDeviceToken(channelId);

  const res = await apiPost('join', { channel_id: channelId, device_token: token });
  if (res.status === 404) { $('#open-error').textContent = 'Clé ou code incorrect.'; return; }
  if (res.status === 403) { $('#open-error').textContent = 'Ce canal est déjà complet (2 appareils).'; return; }
  if (res.status !== 200 || !res.data.ok) { $('#open-error').textContent = 'Échec de connexion.'; return; }

  enterThread({ channelId, ck, token, role: res.data.role,
                closedSeq: res.data.closed_seq || 0 });
});

// =====================================================================
//  THREAD (le fil)
// =====================================================================
function enterThread(sess) {
  S = { ...sess, afterId: 0 };
  show('thread');
  $('#thread-list').innerHTML = '';
  $('#thread-empty').hidden = false;
  $('#thread-status').textContent = S.role === 'A'
    ? (sess.sealedHint ? '' : 'En attente du second participant…')
    : '';
  $('#msg-input').value = '';
  $('#msg-input').focus();
  pull(); // premier tirage immédiat
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') pull();
  }, 2500);
}

async function pull() {
  if (!S) return;
  const res = await apiGet('messages', {
    channel_id: S.channelId, device_token: S.token, after: S.afterId,
  });
  if (res.status !== 200 || !res.data.ok) return;

  // Détection d'un "Fermer" distant : on vide la vue.
  if (res.data.closed_seq > S.closedSeq) {
    S.closedSeq = res.data.closed_seq;
    S.afterId = 0;
    $('#thread-list').innerHTML = '';
    $('#thread-empty').hidden = false;
    $('#thread-status').textContent = 'Le fil a été vidé.';
    return;
  }

  $('#thread-status').textContent = res.data.sealed ? '' : 'En attente du second participant…';

  for (const m of res.data.messages) {
    S.afterId = Math.max(S.afterId, m.id);
    await renderMessage(m);
  }
}

async function renderMessage(m) {
  $('#thread-empty').hidden = true;
  const mine = (m.sender === S.role);
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (mine ? 'mine' : 'theirs');

  try {
    if (m.type === 'text') {
      const txt = await decText(S.ck, m.iv, m.ciphertext);
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = txt;
      wrap.appendChild(bubble);
    } else if (m.type === 'media') {
      const meta = JSON.parse(await decText(S.ck, m.iv, m.ciphertext));
      const bubble = document.createElement('div');
      bubble.className = 'bubble media';
      bubble.textContent = (meta.kind === 'image' ? 'Image…' : (meta.name || 'Fichier…'));
      wrap.appendChild(bubble);
      // Récupère + déchiffre le blob, puis remplace par le rendu réel.
      loadMedia(meta, bubble);
    }
  } catch (e) {
    const bubble = document.createElement('div');
    bubble.className = 'bubble error';
    bubble.textContent = '[contenu illisible]';
    wrap.appendChild(bubble);
  }

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = (m.created_at || '').slice(11, 16);
  wrap.appendChild(time);

  const list = $('#thread-list');
  list.appendChild(wrap);
  list.scrollTop = list.scrollHeight;
}

async function loadMedia(meta, bubble) {
  try {
    const r = await fetch(`${API}?action=media&channel_id=${S.channelId}&device_token=${S.token}&media_id=${meta.media_id}`);
    if (!r.ok) { bubble.textContent = '[média indisponible]'; return; }
    const ctBytes = new Uint8Array(await r.arrayBuffer());
    const plain = await decBytes(S.ck, meta.iv, ctBytes);
    const blob = new Blob([plain], { type: meta.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    bubble.textContent = '';
    if (meta.kind === 'image') {
      const img = document.createElement('img');
      img.src = url; img.alt = meta.name || 'image';
      img.addEventListener('click', () => window.open(url, '_blank'));
      bubble.appendChild(img);
    } else {
      const a = document.createElement('a');
      a.href = url; a.download = meta.name || 'fichier';
      a.textContent = '⬇ ' + (meta.name || 'fichier');
      bubble.appendChild(a);
    }
  } catch (e) {
    bubble.textContent = '[média illisible]';
  }
}

// ---- envoi texte -------------------------------------------------------
async function sendText() {
  const txt = $('#msg-input').value.trim();
  if (!txt || !S) return;
  $('#msg-input').value = '';
  const { iv, ciphertext } = await encText(S.ck, txt);
  const res = await apiPost('send', {
    channel_id: S.channelId, device_token: S.token, type: 'text', iv, ciphertext,
  });
  if (res.status === 200) pull();
  else $('#msg-input').value = txt; // on remet le texte en cas d'échec
}
$('#msg-send').addEventListener('click', sendText);
$('#msg-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
});

// ---- envoi média -------------------------------------------------------
$('#msg-attach').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !S) return;
  if (file.size > 8 * 1024 * 1024) { alert('Fichier trop lourd (8 Mo max).'); return; }

  const buf = new Uint8Array(await file.arrayBuffer());
  const { iv, bytes } = await encBytes(S.ck, buf);

  // 1) dépôt du blob chiffré
  const up = await fetch(`${API}?action=upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Channel': S.channelId, 'X-Device': S.token, 'X-Iv': iv,
    },
    body: bytes,
  });
  const upData = await up.json().catch(() => ({}));
  if (!up.ok || !upData.ok) { alert("Échec de l'envoi du fichier."); return; }

  // 2) message référençant le média (métadonnées chiffrées elles aussi)
  const kind = file.type.startsWith('image/') ? 'image' : 'doc';
  const meta = { kind, media_id: upData.media_id, iv, name: file.name, mime: file.type };
  const m = await encText(S.ck, JSON.stringify(meta));
  await apiPost('send', {
    channel_id: S.channelId, device_token: S.token, type: 'media',
    iv: m.iv, ciphertext: m.ciphertext,
  });
  pull();
});

// ---- fermer (vider) ----------------------------------------------------
$('#thread-close').addEventListener('click', async () => {
  if (!S) return;
  if (!confirm('Vider le fil pour les deux ? La clé et le code restent valables pour reprendre plus tard.')) return;
  const res = await apiPost('close', { channel_id: S.channelId, device_token: S.token });
  if (res.data && typeof res.data.closed_seq === 'number') S.closedSeq = res.data.closed_seq;
  $('#thread-list').innerHTML = '';
  $('#thread-empty').hidden = false;
  $('#thread-status').textContent = 'Fil vidé.';
  S.afterId = 0;
  pull();
});

$('#thread-leave').addEventListener('click', showStart);

// ---- navigation de départ ---------------------------------------------
$('#go-create').addEventListener('click', showCreate);
$('#go-open').addEventListener('click', showOpen);
document.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', showStart));

// Service worker (installabilité + hors-ligne du shell, AUCUN push).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

showStart();
