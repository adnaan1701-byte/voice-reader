const DEFAULTS = { voice: 'aria', rate: 1, showBubble: true, readSymbols: true, overrides: {}, pos: null };
let S = { ...DEFAULTS };
let all = [];
let map = {};

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = r => { r = Math.round(r * 100) / 100; return (Math.abs(r * 10 - Math.round(r * 10)) < 1e-6 ? r.toFixed(1) : r.toFixed(2)) + 'x'; };
const JARVIS_RING = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".45"/><circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="3 1.6"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/></svg>';

const SAMPLES = {
  aria: "Hi, I'm Aria. Highlight any text and I'll read it for you.",
  sophie: "Hello, I'm Sophie. Shall I read that for you?",
  luna: "Hey, I'm Luna. Sit back and relax, I'll do the reading.",
  jarvis: "Good evening, sir. All systems are online. Shall I read the highlighted text?",
  max: "Hey, I'm Max. Let's get through this page together."
};

function save(patch) { Object.assign(S, patch); chrome.storage.local.set(patch); }

function render() {
  map = VR.resolve(all, S.overrides || {});
  $('voices').innerHTML = VR.PRESETS.map(p => {
    const v = map[p.id];
    const av = p.id === 'jarvis' ? `<span class="av jarvis">${JARVIS_RING}</span>` : `<span class="av" style="--c:${p.color}">${p.name[0]}</span>`;
    return `<div class="v ${S.voice === p.id ? 'sel' : ''}" data-id="${p.id}">
      ${av}
      <div class="t"><b>${p.name}</b> <span class="g ${p.gender}">${p.gender === 'male' ? 'Male' : 'Female'}</span>
        <small>${esc(p.tag)} · ${esc(v ? v.name : 'default voice')}</small></div>
      <button class="test" data-test="${p.id}" title="Preview">▶</button>
    </div>`;
  }).join('');

  $('rate').value = S.rate;
  $('rateVal').textContent = fmt(S.rate);
  $('bubble').checked = !!S.showBubble;
  $('symbols').checked = S.readSymbols !== false;

  const sorted = [...all].sort((a, b) => (/^en/i.test(b.lang) - /^en/i.test(a.lang)) || a.name.localeCompare(b.name));
  $('map').innerHTML = VR.PRESETS.map(p => {
    const cur = (S.overrides || {})[p.id] || '';
    const opts = sorted.map(v => `<option value="${esc(v.name)}" ${v.name === cur ? 'selected' : ''}>${esc(v.name)} (${esc(v.lang)})</option>`).join('');
    return `<b>${p.name}</b><select data-map="${p.id}"><option value="">Auto (best match)</option>${opts}</select>`;
  }).join('');
}

function preview(id) {
  speechSynthesis.cancel();
  const p = VR.preset(id);
  const u = new SpeechSynthesisUtterance(SAMPLES[id]);
  const v = map[id];
  if (v) { u.voice = v; u.lang = v.lang; }
  u.rate = Math.min(v && /^google/i.test(v.name) ? 2 : 10, S.rate * p.rate);
  u.pitch = p.pitch;
  speechSynthesis.speak(u);
}

async function send(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    await chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 });
  } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['voices.js', 'content.js'] });
      await chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 });
    } catch (err) {
      $('warn').style.display = 'block';
      return;
    }
  }
  if (msg.type !== 'toggle') window.close();
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-test]');
  if (t) { e.stopPropagation(); preview(t.dataset.test); return; }
  const card = e.target.closest('.v[data-id]');
  if (card) { save({ voice: card.dataset.id }); render(); }
});
$('rate').addEventListener('input', e => { $('rateVal').textContent = fmt(parseFloat(e.target.value)); });
$('rate').addEventListener('change', e => save({ rate: parseFloat(e.target.value) }));
$('bubble').addEventListener('change', e => save({ showBubble: e.target.checked }));
$('symbols').addEventListener('change', e => save({ readSymbols: e.target.checked }));
$('map').addEventListener('change', e => {
  const sel = e.target.closest('[data-map]');
  if (!sel) return;
  const overrides = { ...(S.overrides || {}) };
  if (sel.value) overrides[sel.dataset.map] = sel.value; else delete overrides[sel.dataset.map];
  save({ overrides });
  render();
});
$('read').addEventListener('click', () => send({ type: 'read', pageFallback: true }));
$('toggle').addEventListener('click', () => send({ type: 'toggle' }));
$('stop').addEventListener('click', () => send({ type: 'stop' }));

chrome.storage.local.get(DEFAULTS, async s => {
  S = { ...DEFAULTS, ...s };
  all = await VR.getVoices();
  render();
});
