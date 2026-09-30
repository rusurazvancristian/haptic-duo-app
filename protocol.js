// Pure helpers for the Haptic Duo line protocol (see firmware/PROTOCOL.md).
// No DOM and no Bluetooth here, so everything in this file is easy to test.

export const ACTIONS = [
  ['none', 'Niciuna'],
  ['volume', 'Volum'],
  ['scroll', 'Scroll vertical'],
  ['hscroll', 'Scroll orizontal'],
  ['arrows_lr', 'Săgeți stânga/dreapta'],
  ['arrows_ud', 'Săgeți sus/jos'],
  ['zoom', 'Zoom (Ctrl + rotiță)'],
];

const STIFF = { k: 'stiffness', label: 'Rigiditate', unit: 'V/rad', min: 0, max: 20, step: 0.1, def: 1 };
const DAMP = { k: 'damping', label: 'Amortizare', unit: 'V/(rad/s)', min: 0, max: 1, step: 0.001, def: 0.015 };

// Parameter order equals the order of the `mode` command arguments.
export const MODES = {
  detents: {
    label: 'Detente',
    params: [
      { k: 'spacing', label: 'Distanță între detente', unit: '°', min: 1, max: 360, step: 1, def: 30 },
      STIFF,
      DAMP,
    ],
  },
  spring: { label: 'Arc', params: [STIFF, DAMP] },
  bounded: {
    label: 'Limitat',
    params: [
      { k: 'half_range', label: 'Semi-cursă', unit: '°', min: 1, max: 360, step: 1, def: 90 },
      STIFF,
      DAMP,
    ],
  },
};

export const STEP_MIN = 1;
export const STEP_MAX = 360;
export const PP_MIN = 1;
export const PP_MAX = 100;
export const LIMIT_MIN = 0.001;
export const LIMIT_MAX = 0.6;
export const MAX_PROFILES = 8;
export const BATTERY_LOW_V = 3.5; // below this the UI warns; the firmware only reports, it never cuts off

export function fmtNum(v) {
  return String(+Number(v).toFixed(4));
}

export function defaultParams(mode) {
  return MODES[mode].params.map((p) => p.def);
}

export function modeCommand(side, mode, params) {
  return `mode ${side} ${mode} ${params.map(fmtNum).join(' ')}`;
}

export function bindCommand(side, action, step) {
  return `bind ${side} ${action} ${fmtNum(step)}`;
}

export function validateProfileName(name) {
  return /^[A-Za-z0-9._-]{1,24}$/.test(name);
}

// pole pairs: integer 1..100, limit: 0.001..0.6 V. Returns {value} or {error}.
export function parsePolePairs(text) {
  const t = String(text).trim();
  if (!/^\d+$/.test(t)) return { error: 'Număr întreg între 1 și 100.' };
  const n = Number(t);
  if (n < PP_MIN || n > PP_MAX) return { error: 'Număr întreg între 1 și 100.' };
  return { value: n };
}

export function parseLimit(text) {
  const t = String(text).trim().replace(',', '.');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return { error: 'Tensiune între 0,001 și 0,6 V.' };
  const n = Number(t);
  if (!(n >= LIMIT_MIN && n <= LIMIT_MAX)) return { error: 'Tensiune între 0,001 și 0,6 V.' };
  return { value: n };
}

function kvTokens(tokens) {
  const out = {};
  for (const t of tokens) {
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i)] = t.slice(i + 1);
  }
  return out;
}

// `T state=armed l=1.234 r=-0.5 lh=1 rh=1 p=default`
export function parseTelemetry(line) {
  const t = line.trim().split(/\s+/);
  if (t[0] !== 'T') return null;
  const kv = kvTokens(t.slice(1));
  const l = parseFloat(kv.l);
  const r = parseFloat(kv.r);
  if (!kv.state || !Number.isFinite(l) || !Number.isFinite(r)) return null;
  return {
    state: kv.state,
    l,
    r,
    lh: kv.lh === '1',
    rh: kv.rh === '1',
    p: kv.p === undefined || kv.p === '-' ? null : kv.p,
  };
}

const ACTION_NAMES = ACTIONS.map((a) => a[0]);

// `status` is a sequence of key=value lines. The first line carries state=/fault=,
// then one line per side starting with `left`/`right`. Binding, profile and stream
// rate lines are parsed tolerantly: any line with a side word, an action word and a
// step number sets the binding; profile=/stream= keys are picked up wherever they appear.
// `battery_V=3.92 battery_pct=62` or `battery_V=none` (no cell/divider fitted) fills `battery`,
// which stays null for firmware that does not report it at all.
export function parseStatus(lines) {
  const s = {
    state: null,
    fault: null,
    profile: null,
    stream: null,
    battery: null,
    left: {},
    right: {},
    raw: lines.slice(),
  };
  for (const line of lines) {
    const t = line.trim().split(/\s+/);
    if (!t[0]) continue;
    const kv = kvTokens(t);
    if (kv.state) s.state = kv.state;
    if (kv.fault !== undefined) s.fault = kv.fault === 'none' ? null : kv.fault;
    const profileKey = kv.profile ?? kv.active_profile;
    if (profileKey !== undefined) s.profile = profileKey === '-' ? null : profileKey;
    if (kv.stream !== undefined) s.stream = kv.stream;
    if (kv.battery_V !== undefined) {
      const volts = Number(kv.battery_V);
      const pct = Number(kv.battery_pct);
      s.battery = kv.battery_V !== 'none' && Number.isFinite(volts)
        ? { present: true, volts, pct: kv.battery_pct !== undefined && Number.isFinite(pct) ? pct : null }
        : { present: false };
    }
    if (/^bind/.test(t[0])) {
      for (const key of ['left', 'right']) {
        const [action, stepText] = (kv[key] ?? '').split(/[:,/]/);
        const step = Number(stepText);
        if (ACTION_NAMES.includes(action) && Number.isFinite(step) && step >= STEP_MIN && step <= STEP_MAX) {
          s[key].bind = { action, step };
        }
      }
    }
    const sideWord = t.find((w) => w === 'left' || w === 'right');
    if (sideWord && (t[0] === 'left' || t[0] === 'right' || /^bind/.test(t[0]))) {
      const side = s[sideWord];
      for (const key of ['configured', 'MD', 'ML', 'MH', 'healthy']) {
        if (kv[key] !== undefined) side[key] = kv[key] === '1';
      }
      if (kv.pole_pairs !== undefined) side.pole_pairs = Number(kv.pole_pairs);
      if (kv.limit_V !== undefined) side.limit_V = Number(kv.limit_V);
      if (kv.angle_rad !== undefined) side.angle_rad = Number(kv.angle_rad);
      if (kv.mode !== undefined) side.mode = kv.mode;
      for (const key of ['angle_deg', 'stiffness', 'damping']) {
        const v = Number(kv[key]);
        if (kv[key] !== undefined && Number.isFinite(v)) side[key] = v;
      }
      const bindText = kv.bind ?? kv.binding;
      const words = bindText ? bindText.split(/[:,/]/) : t;
      const ai = words.findIndex((w) => ACTION_NAMES.includes(w));
      if (ai >= 0) {
        const stepText = bindText ? words[ai + 1] : kv.step ?? t[t.indexOf(words[ai]) + 1];
        const step = Number(stepText);
        if (Number.isFinite(step) && step >= STEP_MIN && step <= STEP_MAX) {
          side.bind = { action: words[ai], step };
        }
      }
    }
  }
  return s;
}

// `P <name> L <mode> <p...> <action> <step> R <mode> <p...> <action> <step>`
export function parseProfileLine(line) {
  const t = line.trim().split(/\s+/);
  if (t[0] !== 'P' || t.length < 4) return null;
  const out = { name: t[1] };
  let i = 2;
  for (const [tag, key] of [['L', 'left'], ['R', 'right']]) {
    if (t[i++] !== tag) return null;
    const mode = t[i++];
    const spec = MODES[mode];
    if (!spec) return null;
    const params = [];
    for (let n = 0; n < spec.params.length; n++) params.push(Number(t[i++]));
    const action = t[i++];
    const step = Number(t[i++]);
    if (![...params, step].every(Number.isFinite) || !ACTION_NAMES.includes(action)) return null;
    out[key] = { mode, params, action, step };
  }
  return out;
}

// Text and low-battery flag for the status card; `low` only when a reading exists.
export function describeBattery(b) {
  if (!b) return { text: '—', low: false };
  if (!b.present) return { text: 'nedetectată', low: false };
  const pct = b.pct === null ? '' : ` · ${b.pct}%`;
  return { text: `${b.volts.toFixed(2)} V${pct}`, low: b.volts < BATTERY_LOW_V };
}

export function describeSide(s) {
  const spec = MODES[s.mode];
  const values = s.params.map((v, n) => `${fmtNum(v)}${spec.params[n].unit === '°' ? '°' : ''}`).join(' · ');
  return `${spec.label} ${values}${s.action === 'none' ? '' : ` → ${s.action} /${fmtNum(s.step)}°`}`;
}
