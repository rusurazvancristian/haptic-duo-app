import { Link } from './ble.js';
import {
  ACTIONS, MODES, STEP_MIN, STEP_MAX, MAX_PROFILES, PP_MIN, PP_MAX, LIMIT_MIN, LIMIT_MAX,
  fmtNum, defaultParams, modeCommand, bindCommand, validateProfileName,
  parsePolePairs, parseLimit, parseStatus, parseProfileLine, describeSide, describeBattery, BATTERY_LOW_V,
} from './protocol.js';

const SIDES = ['left', 'right'];
const SIDE_NAME = { left: 'Stânga', right: 'Dreapta' };
const STATE_TEXT = { disabled: 'DEZARMAT', aligning: 'ALINIERE…', armed: 'ARMAT', fault: 'EROARE' };
const STREAM_HZ = 20;
const STATUS_POLL_MS = 15000; // battery is only in `status`, so refresh it slowly while connected
const LIVE_DEBOUNCE_MS = 150;
const CFG_KEY = 'haptic-duo.config.v1';

const $ = (id) => document.getElementById(id);
const link = new Link();

const st = {
  conn: 'idle', // idle | connecting | connected | lost
  tel: null,
  telAt: 0,
  streamAt: 0,
  statusAt: 0,
  status: null,
  profiles: [],
};

function mkSide() {
  return {
    mode: 'detents',
    params: { detents: defaultParams('detents'), spring: defaultParams('spring'), bounded: defaultParams('bounded') },
    bind: { action: 'none', step: 30 },
  };
}
const sides = { left: mkSide(), right: mkSide() };
const ed = {};
const liveTimers = {};

// ---------------------------------------------------------------- helpers

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 6000 : 3000);
}

// Sends a command; toasts and returns null on failure, otherwise the reply lines.
async function run(cmd, opts) {
  try {
    return await link.send(cmd, opts);
  } catch (e) {
    toast(e.message, 'err');
    return null;
  }
}

function confirmBox(text, okLabel = 'Confirmă') {
  return new Promise((resolve) => {
    const d = $('confirm-dialog');
    $('confirm-text').textContent = text;
    $('confirm-ok').textContent = okLabel;
    d.returnValue = '';
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true });
    d.showModal();
  });
}

function curState() {
  return st.tel?.state ?? st.status?.state ?? null;
}
const isConnected = () => st.conn === 'connected';

// ---------------------------------------------------------------- connection

function setConn(conn, msg) {
  st.conn = conn;
  const chip = $('conn-chip');
  chip.textContent = { idle: 'deconectat', connecting: 'se conectează…', connected: 'conectat', lost: 'conexiune pierdută' }[conn];
  chip.className = 'chip ' + { idle: '', connecting: 'busy', connected: 'on', lost: 'lost' }[conn];
  $('btn-connect').hidden = conn === 'connected';
  $('btn-connect').disabled = conn === 'connecting' || !navigator.bluetooth;
  $('btn-connect').textContent = conn === 'lost' ? 'Alege alt dispozitiv' : 'Conectează';
  $('btn-reconnect').hidden = conn !== 'lost';
  $('btn-disconnect').hidden = conn !== 'connected';
  if (msg !== undefined) $('conn-msg').textContent = msg;
  renderAll();
}

function showPairHint(show) {
  $('pair-hint').hidden = !show;
}

async function afterOpen() {
  st.tel = null;
  st.status = null;
  setConn('connected', `Conectat la ${link.name}.`);
  showPairHint(false);
  await startStream();
  await refreshStatus({ force: true });
  await refreshProfiles();
  renderAll();
}

async function startStream() {
  st.streamAt = performance.now();
  await run(`stream ${STREAM_HZ}`);
}

async function doConnect() {
  if (!navigator.bluetooth) return;
  setConn('connecting', 'Se caută dispozitivul…');
  try {
    await link.connect();
  } catch (e) {
    if (e.name === 'NotFoundError') {
      setConn(link.device ? 'lost' : 'idle', 'Nicio selecție.');
    } else {
      setConn(link.device ? 'lost' : 'idle', `Conectare eșuată: ${e.message}`);
      showPairHint(true);
    }
    return;
  }
  await afterOpen();
}

async function doReconnect() {
  setConn('connecting', 'Se reconectează…');
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await link.reconnect();
      await afterOpen();
      return;
    } catch (e) {
      lastError = e;
    }
  }
  setConn('lost', `Reconectare eșuată: ${lastError.message}`);
  showPairHint(true);
}

link.addEventListener('disconnected', (e) => {
  if (st.conn !== 'connected') return;
  if (e.detail.byUser) {
    setConn('idle', 'Deconectat. Placa rămâne în starea ei (dacă era armată, rămâne armată).');
  } else {
    setConn('lost', 'Conexiunea BLE s-a pierdut. Placa NU se dezarmează singură: dacă era armată, rămâne armată.');
    toast('Conexiune pierdută', 'err');
  }
  st.tel = null;
  renderAll();
});

link.addEventListener('telemetry', (e) => {
  const t = e.detail;
  const prev = st.tel;
  st.tel = t;
  st.telAt = performance.now();
  renderDials();
  if (!prev || prev.state !== t.state) {
    renderAll();
    if (prev) scheduleStatus();
  }
  if (!prev || prev.p !== t.p) {
    renderProfiles();
    $('active-profile').textContent = t.p ?? '— (nimic încărcat / modificat)';
    if (prev && t.p) onProfileChanged(t.p);
  }
});

link.addEventListener('event', (e) => {
  if (e.detail === 'OK armed') {
    toast('Armat', 'ok');
    scheduleStatus();
  } else if (/^ERR\b/.test(e.detail)) {
    toast(`Dispozitiv: ${e.detail}`, 'err');
    scheduleStatus();
  }
});

let statusTimer = null;
function scheduleStatus() {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => refreshStatus(), 250);
}

async function refreshStatus({ force = false } = {}) {
  if (!isConnected()) return;
  st.statusAt = performance.now();
  const lines = await run('status');
  if (!lines) return;
  st.status = parseStatus(lines);
  if (force) applyStatusToEditors(st.status);
  renderAll();
}

function applyStatusToEditors(status) {
  for (const s of SIDES) {
    const info = status[s];
    if (info.mode && MODES[info.mode]) sides[s].mode = info.mode;
    if (info.mode && MODES[info.mode]) {
      const values = MODES[info.mode].params.map((p) => {
        const v = p.k === 'stiffness' || p.k === 'damping' ? info[p.k] : info.angle_deg;
        return Number.isFinite(v) && v >= p.min && v <= p.max ? v : null;
      });
      if (values.every((v) => v !== null)) sides[s].params[info.mode] = values;
    }
    if (info.bind) sides[s].bind = { ...info.bind };
    renderEditor(s);
  }
}

// ---------------------------------------------------------------- dials

function buildDials() {
  for (const s of SIDES) {
    const box = document.createElement('div');
    box.className = 'dial stale';
    box.id = `dial-${s}`;
    let ticks = '';
    for (let i = 0; i < 24; i++) {
      const major = i % 6 === 0;
      ticks += `<line class="tick ${major ? 'major' : ''}" x1="60" y1="${major ? 8 : 10}" x2="60" y2="${major ? 20 : 16}" transform="rotate(${i * 15} 60 60)"/>`;
    }
    box.innerHTML = `
      <div class="name">${SIDE_NAME[s]}</div>
      <svg viewBox="0 0 120 120" role="img" aria-label="Cadran ${SIDE_NAME[s]}">
        <circle class="ring" cx="60" cy="60" r="54"/>${ticks}
        <g class="needle-g"><line class="needle" x1="60" y1="60" x2="60" y2="16"/></g>
        <circle class="hub" cx="60" cy="60" r="6"/>
      </svg>
      <div class="deg">—</div>
      <div class="health"><span class="dot"></span><span class="htext">senzor —</span></div>`;
    $('dials').append(box);
  }
}

function renderDials() {
  const t = st.tel;
  const fresh = t && isConnected() && performance.now() - st.telAt < 2500;
  for (const s of SIDES) {
    const box = $(`dial-${s}`);
    box.classList.toggle('stale', !fresh);
    if (!t) {
      box.querySelector('.deg').textContent = '—';
      box.querySelector('.dot').className = 'dot';
      box.querySelector('.htext').textContent = 'senzor —';
      continue;
    }
    const rad = s === 'left' ? t.l : t.r;
    const healthy = s === 'left' ? t.lh : t.rh;
    const deg = (rad * 180) / Math.PI;
    box.querySelector('.needle-g').style.transform = `rotate(${deg}deg)`;
    box.querySelector('.deg').textContent = `${deg.toFixed(1)}° (${(deg / 360).toFixed(2)} rot)`;
    box.querySelector('.dot').className = 'dot ' + (healthy ? 'ok' : 'bad');
    box.querySelector('.htext').textContent = healthy ? 'senzor OK' : 'senzor DEFECT';
  }
}

// ---------------------------------------------------------------- config

function loadCfg() {
  try {
    return JSON.parse(localStorage.getItem(CFG_KEY)) || {};
  } catch {
    return {};
  }
}
function saveCfg() {
  const cfg = {};
  for (const s of SIDES) cfg[s] = { pp: $(`cfg-${s}-pp`).value, v: $(`cfg-${s}-v`).value };
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  } catch {
    /* storage disabled */
  }
}

function buildConfig() {
  const saved = loadCfg();
  for (const s of SIDES) {
    const box = document.createElement('div');
    box.className = 'cfg';
    box.innerHTML = `
      <h3>${SIDE_NAME[s]}</h3>
      <label for="cfg-${s}-pp">Perechi de poli (întreg ${PP_MIN}–${PP_MAX})</label>
      <input id="cfg-${s}-pp" type="text" inputmode="numeric" placeholder="introdu valoarea confirmată" autocomplete="off">
      <p class="err-text small" id="cfg-${s}-pp-err" hidden></p>
      <label for="cfg-${s}-v">Limită tensiune (V, ${fmtNum(LIMIT_MIN)}–${fmtNum(LIMIT_MAX)})</label>
      <input id="cfg-${s}-v" type="text" inputmode="decimal" placeholder="ex. 0.3" autocomplete="off">
      <p class="err-text small" id="cfg-${s}-v-err" hidden></p>
      <div class="row"><button class="btn primary" id="cfg-${s}-send" type="button">Trimite config ${SIDE_NAME[s].toLowerCase()}</button></div>
      <div class="dev" id="cfg-${s}-dev">În dispozitiv: —</div>`;
    $('cfg-grid').append(box);
    // Only what the user typed earlier is restored; nothing is ever pre-filled otherwise.
    if (saved[s]) {
      $(`cfg-${s}-pp`).value = saved[s].pp ?? '';
      $(`cfg-${s}-v`).value = saved[s].v ?? '';
    }
    $(`cfg-${s}-pp`).addEventListener('input', saveCfg);
    $(`cfg-${s}-v`).addEventListener('input', saveCfg);
    $(`cfg-${s}-send`).addEventListener('click', () => sendConfig(s));
  }
}

async function sendConfig(s) {
  const pp = parsePolePairs($(`cfg-${s}-pp`).value);
  const lim = parseLimit($(`cfg-${s}-v`).value);
  const ppErr = $(`cfg-${s}-pp-err`);
  const vErr = $(`cfg-${s}-v-err`);
  ppErr.hidden = !pp.error;
  ppErr.textContent = pp.error ?? '';
  vErr.hidden = !lim.error;
  vErr.textContent = lim.error ?? '';
  if (pp.error || lim.error) return;
  if (curState() !== 'disabled') {
    toast('Config se poate trimite doar în starea „dezarmat”.', 'err');
    return;
  }
  const btn = $(`cfg-${s}-send`);
  btn.disabled = true;
  const reply = await run(`config ${s} ${pp.value} ${fmtNum(lim.value)}`);
  if (reply) toast(`Config ${SIDE_NAME[s].toLowerCase()} trimisă`, 'ok');
  await refreshStatus();
  renderAll();
}

// ---------------------------------------------------------------- mode + binding editors

function buildEditors() {
  for (const s of SIDES) {
    const box = document.createElement('div');
    box.className = 'editor';
    box.id = `editor-${s}`;
    box.innerHTML = `
      <h3>${SIDE_NAME[s]}</h3>
      <div class="seg">${Object.entries(MODES)
        .map(([k, m]) => `<button type="button" data-mode="${k}" aria-pressed="false">${m.label}</button>`)
        .join('')}</div>
      <div class="params"></div>
      <div class="row"><button type="button" class="btn primary apply">Aplică modul</button></div>
      <hr>
      <div class="param">
        <div class="lbl"><label for="bind-${s}-action">Acțiune (USB HID)</label></div>
        <select id="bind-${s}-action">${ACTIONS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
      </div>
      <div class="param">
        <div class="lbl"><label for="bind-${s}-step">Pas (grade / eveniment)</label><span>${STEP_MIN}–${STEP_MAX}°</span></div>
        <div class="pair">
          <input type="range" min="${STEP_MIN}" max="${STEP_MAX}" step="1" id="bind-${s}-range" aria-label="Pas ${SIDE_NAME[s]}">
          <input type="number" min="${STEP_MIN}" max="${STEP_MAX}" step="any" id="bind-${s}-step">
        </div>
      </div>
      <div class="row"><button type="button" class="btn primary" id="bind-${s}-send">Setează legătura</button></div>`;
    $('editors').append(box);
    ed[s] = {
      box,
      seg: box.querySelector('.seg'),
      params: box.querySelector('.params'),
      apply: box.querySelector('.apply'),
    };
    ed[s].seg.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-mode]');
      if (!b) return;
      sides[s].mode = b.dataset.mode;
      renderEditor(s);
      scheduleLive(s);
    });
    ed[s].apply.addEventListener('click', () => sendMode(s, true));

    const action = $(`bind-${s}-action`);
    const range = $(`bind-${s}-range`);
    const num = $(`bind-${s}-step`);
    action.addEventListener('change', () => (sides[s].bind.action = action.value));
    range.addEventListener('input', () => {
      num.value = range.value;
      sides[s].bind.step = Number(range.value);
    });
    num.addEventListener('input', () => {
      const v = Number(num.value);
      if (num.value !== '' && Number.isFinite(v)) {
        sides[s].bind.step = v;
        if (v >= STEP_MIN && v <= STEP_MAX) range.value = v;
      }
    });
    $(`bind-${s}-send`).addEventListener('click', () => sendBind(s));
    renderEditor(s);
  }
}

function renderEditor(s) {
  const side = sides[s];
  const spec = MODES[side.mode];
  for (const b of ed[s].seg.children) b.setAttribute('aria-pressed', String(b.dataset.mode === side.mode));
  const box = ed[s].params;
  box.textContent = '';
  spec.params.forEach((p, i) => {
    const values = side.params[side.mode];
    const wrap = document.createElement('div');
    wrap.className = 'param';
    wrap.innerHTML = `
      <div class="lbl"><label for="p-${s}-${i}">${p.label}</label><span>${fmtNum(p.min)}–${fmtNum(p.max)} ${p.unit}</span></div>
      <div class="pair">
        <input type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${values[i]}" aria-label="${p.label} ${SIDE_NAME[s]}">
        <input type="number" id="p-${s}-${i}" min="${p.min}" max="${p.max}" step="any" value="${fmtNum(values[i])}">
      </div>`;
    const [range, num] = wrap.querySelectorAll('input');
    range.addEventListener('input', () => {
      num.value = fmtNum(range.value);
      values[i] = Number(range.value);
      scheduleLive(s);
    });
    num.addEventListener('input', () => {
      const v = Number(num.value);
      if (num.value === '' || !Number.isFinite(v)) return;
      values[i] = v;
      if (v >= p.min && v <= p.max) range.value = v;
      scheduleLive(s);
    });
    box.append(wrap);
  });
  $(`bind-${s}-action`).value = side.bind.action;
  $(`bind-${s}-range`).value = side.bind.step;
  $(`bind-${s}-step`).value = fmtNum(side.bind.step);
}

function modeParamsValid(s) {
  const side = sides[s];
  return MODES[side.mode].params.every((p, i) => {
    const v = side.params[side.mode][i];
    return Number.isFinite(v) && v >= p.min && v <= p.max;
  });
}

function scheduleLive(s) {
  if (!isConnected() || curState() !== 'armed') return;
  clearTimeout(liveTimers[s]);
  liveTimers[s] = setTimeout(() => sendMode(s, false), LIVE_DEBOUNCE_MS);
}

async function sendMode(s, manual) {
  if (!isConnected()) return;
  if (curState() === 'aligning') {
    toast('Mod respins în timpul alinierii.', 'err');
    return;
  }
  if (!modeParamsValid(s)) {
    if (manual) toast('Parametri în afara intervalului.', 'err');
    return;
  }
  const side = sides[s];
  const reply = await run(modeCommand(s, side.mode, side.params[side.mode]));
  if (reply && manual) toast(`Mod ${SIDE_NAME[s].toLowerCase()} aplicat`, 'ok');
}

async function sendBind(s) {
  const b = sides[s].bind;
  if (!Number.isFinite(b.step) || b.step < STEP_MIN || b.step > STEP_MAX) {
    toast(`Pasul trebuie să fie între ${STEP_MIN} și ${STEP_MAX}°.`, 'err');
    return;
  }
  const reply = await run(bindCommand(s, b.action, b.step));
  if (reply) toast(`Legătură ${SIDE_NAME[s].toLowerCase()} setată`, 'ok');
}

// ---------------------------------------------------------------- profiles

async function refreshProfiles() {
  if (!isConnected()) return;
  const lines = await run('profile list');
  if (lines) st.profiles = lines.map(parseProfileLine).filter(Boolean);
  renderProfiles();
}

function applyProfileToEditors(p) {
  for (const s of SIDES) {
    const d = p[s];
    sides[s].mode = d.mode;
    sides[s].params[d.mode] = d.params.slice();
    sides[s].bind = { action: d.action, step: d.step };
    renderEditor(s);
  }
}

async function onProfileChanged(name) {
  let p = st.profiles.find((x) => x.name === name);
  if (!p) {
    await refreshProfiles();
    p = st.profiles.find((x) => x.name === name);
  }
  if (p) applyProfileToEditors(p);
}

function renderProfiles() {
  const ul = $('profile-list');
  ul.textContent = '';
  const active = st.tel?.p ?? null;
  const on = isConnected();
  for (const p of st.profiles) {
    const li = document.createElement('li');
    li.dataset.name = p.name;
    if (p.name === active) li.className = 'active';
    li.innerHTML = `
      <div class="pname"></div>
      <p class="pdesc"></p>
      <p class="pdesc"></p>
      <div class="row">
        <button class="btn primary load" type="button">Încarcă</button>
        <button class="btn danger del" type="button">Șterge</button>
      </div>`;
    li.querySelector('.pname').textContent = p.name + (p.name === active ? ' (activ)' : '');
    const [dl, dr] = li.querySelectorAll('.pdesc');
    dl.textContent = `Stânga: ${describeSide(p.left)}`;
    dr.textContent = `Dreapta: ${describeSide(p.right)}`;
    li.querySelector('.load').disabled = !on || curState() === 'aligning';
    li.querySelector('.del').disabled = !on;
    li.querySelector('.load').addEventListener('click', () => loadProfile(p.name));
    li.querySelector('.del').addEventListener('click', () => deleteProfile(p.name));
    ul.append(li);
  }
  $('profile-empty').hidden = st.profiles.length > 0 || !on;
}

async function loadProfile(name) {
  const reply = await run(`profile load ${name}`);
  if (!reply) return;
  const p = st.profiles.find((x) => x.name === name);
  if (p) applyProfileToEditors(p);
  toast(`Profil „${name}” încărcat`, 'ok');
  scheduleStatus();
}

async function deleteProfile(name) {
  if (!(await confirmBox(`Ștergi profilul „${name}”?`, 'Șterge'))) return;
  const reply = await run(`profile delete ${name}`);
  if (reply) toast(`Profil „${name}” șters`, 'ok');
  await refreshProfiles();
}

async function saveProfile(ev) {
  ev.preventDefault();
  const raw = $('save-name').value.trim();
  const err = $('save-err');
  let msg = '';
  if (!validateProfileName(raw)) {
    msg = 'Nume invalid: 1–24 caractere din A-Z a-z 0-9 . _ -';
  } else if (!st.profiles.some((p) => p.name === raw.toLowerCase()) && st.profiles.length >= MAX_PROFILES) {
    msg = `Ai deja ${MAX_PROFILES} profile; șterge unul mai întâi.`;
  }
  err.hidden = !msg;
  err.textContent = msg;
  if (msg) return;
  const reply = await run(`profile save ${raw}`);
  if (reply) {
    toast(`Profil „${raw.toLowerCase()}” salvat`, 'ok');
    $('save-name').value = '';
  }
  await refreshProfiles();
}

// ---------------------------------------------------------------- arm / disarm

function armBlockReason() {
  if (!isConnected()) return 'Conectează-te mai întâi.';
  const state = curState();
  if (state === 'fault') return 'Eroare blocată: rezolvă cauza, apoi „disarm clear”.';
  if (state === 'armed') return 'Deja armat.';
  if (state === 'aligning') return 'Se aliniază…';
  if (state !== 'disabled') return 'Se așteaptă starea dispozitivului…';
  if (!st.status) return 'Se așteaptă starea dispozitivului…';
  const missing = SIDES.filter((s) => !st.status[s].configured).map((s) => SIDE_NAME[s].toLowerCase());
  if (missing.length) return `Neconfigurat în dispozitiv: ${missing.join(', ')}. Trimite mai întâi config.`;
  const bad = SIDES.filter((s) => st.status[s].healthy === false).map((s) => SIDE_NAME[s].toLowerCase());
  if (bad.length) return `Senzor nesănătos: ${bad.join(', ')}.`;
  return '';
}

function openArmDialog() {
  const d = $('arm-dialog');
  const checks = [...d.querySelectorAll('.arm-check')];
  checks.forEach((c) => (c.checked = false));
  $('arm-ok').disabled = true;
  d.returnValue = '';
  d.addEventListener('close', () => d.returnValue === 'ok' && doArm(), { once: true });
  d.showModal();
}

async function doArm() {
  const reply = await run('arm', { timeout: 5000 });
  if (reply) toast('Aliniere pornită — nu atinge butoanele', 'ok');
  scheduleStatus();
}

async function doDisarm() {
  for (const s of SIDES) clearTimeout(liveTimers[s]);
  let reply = await run('disarm', { priority: true });
  if (!reply && isConnected()) reply = await run('disarm', { priority: true });
  if (reply) toast('Dezarmat', 'ok');
  scheduleStatus();
}

async function doClear() {
  const reply = await run('disarm clear');
  if (reply) toast('Eroarea a fost ștearsă', 'ok');
  await refreshStatus();
}

// ---------------------------------------------------------------- rendering

function renderAll() {
  const on = isConnected();
  const state = on ? curState() : null;
  const badge = $('state-badge');
  badge.textContent = STATE_TEXT[state] ?? '—';
  badge.className = 'badge ' + (state ?? '');

  const fault = st.status?.fault;
  const fb = $('fault-banner');
  fb.hidden = !(on && (state === 'fault' || fault));
  fb.textContent = fault
    ? `Eroare blocată: ${fault}. Dispozitivul rămâne dezactivat până la „disarm clear”.`
    : 'Eroare blocată (motiv necunoscut încă — apasă „Reîmprospătează”).';

  $('btn-clear').hidden = !(on && state === 'fault');
  $('btn-status').disabled = !on;
  const why = armBlockReason();
  $('btn-arm').disabled = !!why;
  $('arm-why').textContent = why;
  $('btn-disarm').disabled = !on;
  if (!on) $('active-profile').textContent = '—';

  const battery = describeBattery(on ? st.status?.battery : null);
  $('battery').textContent = battery.text;
  $('battery').classList.toggle('batt-low', battery.low);
  const bb = $('battery-banner');
  bb.hidden = !battery.low;
  bb.textContent = `Baterie scăzută (sub ${BATTERY_LOW_V.toFixed(1)} V): încarcă celula. Doar avertisment — firmware-ul nu oprește nimic; protecția la subtensiune o face BMS-ul celulei.`;

  const fresh = on && st.tel && performance.now() - st.telAt < 2500;
  $('tel-state').textContent = !on ? 'oprită' : fresh ? `${STREAM_HZ} Hz` : 'fără date';

  for (const s of SIDES) {
    const canCfg = on && state === 'disabled';
    $(`cfg-${s}-send`).disabled = !canCfg;
    const info = st.status?.[s];
    $(`cfg-${s}-dev`).textContent =
      !on || !info
        ? 'În dispozitiv: —'
        : info.configured
          ? `În dispozitiv: configurat, ${info.pole_pairs} perechi de poli, ${Number(info.limit_V).toFixed(3)} V`
          : 'În dispozitiv: neconfigurat';
    const aligning = state === 'aligning';
    for (const b of ed[s].seg.children) b.disabled = !on || aligning;
    ed[s].box.querySelectorAll('.params input').forEach((i) => (i.disabled = !on || aligning));
    ed[s].apply.disabled = !on || aligning;
    ed[s].apply.hidden = state === 'armed';
    for (const id of [`bind-${s}-action`, `bind-${s}-range`, `bind-${s}-step`, `bind-${s}-send`]) $(id).disabled = !on;
  }
  $('live-note').textContent =
    state === 'armed'
      ? 'Armat: modificările se trimit automat (după ~150 ms). Firmware-ul recentrează originea la poziția curentă, deci legea nu produce salturi.'
      : state === 'aligning'
        ? 'Aliniere în curs: modul nu poate fi schimbat acum.'
        : 'Modificările se trimit cu „Aplică modul” și au efect la următoarea armare. La conectare și la „Reîmprospătează” valorile se citesc din dispozitiv.';
  $('btn-plist').disabled = !on;
  $('btn-save').disabled = !on;
  $('save-name').disabled = !on;
  $('console-input').disabled = !on;
  renderDials();
  renderProfiles();
}

// ---------------------------------------------------------------- console

const CONSOLE_MAX = 400;
function consoleLog(cls, text) {
  const el = $('console');
  const line = document.createElement('div');
  line.className = cls;
  line.textContent = (cls === 'tx' ? '> ' : '< ') + text;
  const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
  el.append(line);
  while (el.childElementCount > CONSOLE_MAX) el.firstElementChild.remove();
  if (stick) el.scrollTop = el.scrollHeight;
}
link.addEventListener('tx', (e) => consoleLog('tx', e.detail));
link.addEventListener('line', (e) => consoleLog(/^ERR\b/.test(e.detail) ? 'er' : 'rx', e.detail));
link.addEventListener('telemetry-line', (e) => $('console-tel').checked && consoleLog('rx', e.detail));

// ---------------------------------------------------------------- init

function unsupportedMessage() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios) {
    return 'Safari pe iPhone/iPad nu suportă Web Bluetooth. Instalează browserul gratuit „Bluefy” din App Store și deschide această pagină în el.';
  }
  if (!window.isSecureContext) {
    return 'Web Bluetooth cere conexiune sigură (HTTPS). Deschide pagina prin adresa https:// a site-ului.';
  }
  return 'Acest browser nu suportă Web Bluetooth. Folosește Chrome sau Edge (Android, Windows, macOS); pe iPhone folosește Bluefy.';
}

function init() {
  buildDials();
  buildConfig();
  buildEditors();
  if (!navigator.bluetooth) {
    const b = $('unsupported');
    b.hidden = false;
    b.textContent = unsupportedMessage();
  }

  $('btn-connect').addEventListener('click', doConnect);
  $('btn-reconnect').addEventListener('click', doReconnect);
  $('btn-disconnect').addEventListener('click', () => link.disconnect());
  $('btn-status').addEventListener('click', () => refreshStatus({ force: true }));
  $('btn-arm').addEventListener('click', openArmDialog);
  $('btn-clear').addEventListener('click', doClear);
  $('btn-disarm').addEventListener('click', doDisarm);
  $('btn-plist').addEventListener('click', refreshProfiles);
  $('save-form').addEventListener('submit', saveProfile);
  $('arm-dialog').addEventListener('change', () => {
    $('arm-ok').disabled = ![...document.querySelectorAll('.arm-check')].every((c) => c.checked);
  });
  $('console-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = $('console-input').value.trim();
    if (!text) return;
    $('console-input').value = '';
    run(text);
  });

  // Telemetry watchdog: mark the dials stale and re-request the stream if it stops.
  setInterval(() => {
    if (!isConnected()) return;
    const stale = !st.tel || performance.now() - st.telAt > 2500;
    renderDials();
    $('tel-state').textContent = stale ? 'fără date' : `${STREAM_HZ} Hz`;
    if (performance.now() - st.statusAt > STATUS_POLL_MS && !link.cur) refreshStatus();
    if (stale && performance.now() - st.streamAt > 5000 && !link.cur) startStream();
  }, 1000);

  setConn('idle');
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
