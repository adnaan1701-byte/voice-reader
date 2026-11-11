// Voice Reader — page script: selection bubble, voice menu, draggable player, speech engine.
(() => {
  if (window.__voiceReaderLoaded) return;
  window.__voiceReaderLoaded = true;
  const VR = globalThis.VR;
  if (!VR || typeof speechSynthesis === 'undefined') return;

  const ROOT_ID = 'voice-reader-ext-root';
  document.getElementById(ROOT_ID)?.remove(); // leftover from a reloaded extension

  /* ---------------- settings ---------------- */
  const DEFAULTS = { voice: 'aria', rate: 1, showBubble: true, readSymbols: true, overrides: {}, pos: null };
  let S = { ...DEFAULTS };
  let voiceMap = {};
  let pending = {}, saveTimer = null;

  function safeStore(fn) { try { fn(chrome.storage.local); } catch (e) { /* extension reloaded */ } }
  function save(patch) {
    Object.assign(S, patch);
    Object.assign(pending, patch);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { const p = pending; pending = {}; safeStore(st => st.set(p)); }, 250);
  }
  safeStore(st => st.get(DEFAULTS, s => { S = { ...DEFAULTS, ...s }; refreshVoices(); renderAll(); placePlayer(); }));
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      for (const k in ch) S[k] = ch[k].newValue;
      if (ch.overrides) refreshVoices();
      renderAll();
      if ((ch.rate || ch.voice || ch.overrides || ch.readSymbols) && R.applied &&
          (R.applied.rate !== S.rate || R.applied.voice !== S.voice || ch.overrides || ch.readSymbols)) R.restart();
    });
  } catch (e) {}

  function refreshVoices() { voiceMap = VR.resolve(speechSynthesis.getVoices(), S.overrides || {}); }
  speechSynthesis.addEventListener('voiceschanged', () => { refreshVoices(); renderAll(); });
  refreshVoices();

  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const fmtRate = r => { r = Math.round(r * 100) / 100; return (Math.abs(r * 10 - Math.round(r * 10)) < 1e-6 ? r.toFixed(1) : r.toFixed(2)) + 'x'; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));


  /* ---------------- code-aware reading ---------------- */
  // BEGIN-SPEAKABLE
  // Turns file names, paths, commands, IPs and URLs into words so they are read
  // symbol by symbol ("login.html" -> "login dot H T M L") instead of pausing at the dot.
  const SYM = { '.': 'dot', '/': 'slash', '\\': 'backslash', '_': 'underscore', '-': 'dash', ':': 'colon',
    '@': 'at', '=': 'equals', '|': 'pipe', '>': 'greater than', '<': 'less than', '{': 'open brace',
    '}': 'close brace', '[': 'open bracket', ']': 'close bracket', '$': 'dollar', '~': 'tilde', '*': 'star',
    '#': 'hash', '&': 'and', '%': 'percent', '+': 'plus', ';': 'semicolon', '?': 'question mark',
    '^': 'caret', '!': 'bang', ',': 'comma' };
  const SAY = { exe: 'E X E', dll: 'D L L', lnk: 'L N K', ps1: 'P S 1', sh: 'S H', py: 'P Y', js: 'J S',
    json: 'Jason', html: 'H T M L', htm: 'H T M', css: 'C S S', php: 'P H P', sql: 'S Q L', txt: 'text',
    md: 'M D', csv: 'C S V', xml: 'X M L', pdf: 'P D F', cmd: 'C M D', ssh: 'S S H', http: 'H T T P',
    https: 'H T T P S', www: 'W W W', etc: 'E T C', usr: 'user', tmp: 'temp', src: 'source', ftp: 'F T P',
    smb: 'S M B', tcp: 'T C P', udp: 'U D P', dns: 'D N S', ip: 'I P', url: 'U R L', vbs: 'V B S',
    hta: 'H T A', msi: 'M S I', iso: 'I S O', jpg: 'J peg', png: 'P N G', docx: 'doc X', xlsx: 'X L S X',
    yml: 'yaml', cfg: 'config', conf: 'conf', db: 'D B', pcap: 'P cap', ovpn: 'O V P N', id_rsa: 'I D R S A' };
  const LEAD = /^[(\[{"'`“‘]+/;
  const TRAIL = /[)\]}"'`”’.,;:!?]+$/;
  const SILENT = /[()'"`“”‘’]/;
  const IS_ABBREV = /^([A-Za-z]\.)+[A-Za-z]?$/;
  const IS_NUMBER = /^([$€£]?\d{1,3}(,\d{3})+(\.\d+)?%?|[$€£]?\d+(\.\d+)?%?|\d{1,2}:\d{2}(:\d{2})?|\d+(st|nd|rd|th))$/i;
  const HAS_SYMBOL = /[.\/\\_:@=|<>{}\[\]$~*#&%+;?^!]/;

  function isTechnical(core) {
    if (!core || IS_ABBREV.test(core) || IS_NUMBER.test(core)) return false;
    if (/^[^\w\s]+$/.test(core)) return core.length <= 4 && /[|<>&;=$*~]/.test(core); // |, >, &&, >>, 2>&1 etc.
    if (/^-{1,2}[A-Za-z]/.test(core)) return true;                                   // -c, --help
    if (/^(\.{0,2}[\/\\~]|[$%])/.test(core)) return true;                            // /etc, ./run, ~/x, $HOME
    return HAS_SYMBOL.test(core);                                                   // login.html, a@b.c, 10.10.1.5
  }
  function wordOut(w) {
    const low = w.toLowerCase();
    if (SAY[low]) return SAY[low];
    return w.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  }
  function spellCode(core) {
    const out = [];
    let word = '';
    const flush = () => { if (word) { out.push(wordOut(word)); word = ''; } };
    for (const ch of core) {
      if (/[A-Za-z0-9]/.test(ch)) { word += ch; continue; }
      flush();
      if (SILENT.test(ch)) continue;
      if (SYM[ch]) out.push(SYM[ch]);
    }
    flush();
    return out.join(' ');
  }
  // Returns the text to speak plus a map back to positions in the original text.
  function speakable(text) {
    let spoken = '';
    const map = [];
    const re = /\S+|\s+/g;
    let m;
    while ((m = re.exec(text))) {
      const tok = m[0];
      map.push([spoken.length, m.index]);
      if (/^\s/.test(tok)) { spoken += ' '; continue; }
      const lead = (tok.match(LEAD) || [''])[0];
      let rest = tok.slice(lead.length);
      let trail = (rest.match(TRAIL) || [''])[0];
      let core = rest.slice(0, rest.length - trail.length);
      if (!core && rest) { core = rest; trail = ''; }
      if (isTechnical(core)) {
        const t = trail.replace(/[)\]}"'`”’]/g, '');
        spoken += spellCode(core) + (t ? t[0] : '');
      } else {
        spoken += tok;
      }
    }
    return { text: spoken, map };
  }
  function mapBack(map, i) {
    if (!map) return i;
    let lo = 0, hi = map.length - 1, best = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (map[mid][0] <= i) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    return map[best][1];
  }
  // Sentence splitter that only breaks on . ! ? followed by a space (so login.html stays whole).
  function chunkText(text, max = 180) {
    const paragraphs = String(text || '').split(/\r?\n/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const out = [];
    for (const para of paragraphs) {
      const pieces = [];
      for (let s of para.split(/(?<=[.!?。！？]["'”’)\]]*)\s+/)) {
        s = s.trim();
        if (!s) continue;
        while (s.length > max) {
          let cut = Math.max(s.lastIndexOf(', ', max), s.lastIndexOf('; ', max));
          if (cut < max * 0.4) cut = s.lastIndexOf(' ', max);
          if (cut < max * 0.3) cut = max - 1;
          pieces.push(s.slice(0, cut + 1).trim());
          s = s.slice(cut + 1).trim();
        }
        if (s) pieces.push(s);
      }
      const merged = [];
      for (const s of pieces) {
        const last = merged[merged.length - 1];
        if (last && last.length < 60 && last.length + s.length < 150) merged[merged.length - 1] = last + ' ' + s;
        else merged.push(s);
      }
      out.push(...merged);
    }
    return out;
  }
  // END-SPEAKABLE

  /* ---------------- speech engine ---------------- */
  // Some voices have a top speed. Google's voices in Chrome stop working above 2x.
  const learnedCaps = {};
  function rateCap(v) {
    if (!v) return 10;
    if (learnedCaps[v.name]) return learnedCaps[v.name];
    if (/^google/i.test(v.name)) return 2;
    return 10;
  }

  const R = {
    chunks: [], cum: [], total: 0, idx: 0, offset: 0, boundary: 0,
    state: 'idle', // idle | playing | paused | done
    token: 0, utter: null, keepAlive: null, applied: null,

    start(text) {
      const chunks = chunkText(text);
      if (!chunks.length) return;
      this.token++;
      speechSynthesis.cancel();
      this.chunks = chunks;
      this.cum = []; let acc = 0;
      for (const c of chunks) { this.cum.push(acc); acc += c.length; }
      this.total = acc;
      this.idx = 0; this.offset = 0; this.boundary = 0;
      this.state = 'playing';
      showPlayer();
      this.speak();
    },

    speak() {
      const t = ++this.token;
      speechSynthesis.cancel();
      if (this.idx >= this.chunks.length) return this.finish();
      const full = this.chunks[this.idx];
      const src = full.slice(this.offset);
      if (!src.trim()) { this.idx++; this.offset = 0; return this.speak(); }
      const sp = S.readSymbols !== false ? speakable(src) : { text: src, map: null };
      const text = sp.text;
      this.boundary = this.offset;
      const p = VR.preset(S.voice);
      const v = voiceMap[p.id];
      const u = new SpeechSynthesisUtterance(text);
      if (v) { u.voice = v; u.lang = v.lang; }
      const want = S.rate * p.rate;
      const cap = rateCap(v);
      u.rate = clamp(Math.min(want, cap), 0.1, 10);
      this.capped = want > cap + 0.001 ? cap : 0;
      u.pitch = p.pitch;
      u.volume = 1;
      u.onboundary = e => {
        if (t !== this.token || (e.name && e.name !== 'word')) return;
        this.boundary = this.offset + mapBack(sp.map, e.charIndex);
        updateProgress();
      };
      u.onend = () => { if (t !== this.token) return; this.idx++; this.offset = 0; this.speak(); };
      u.onerror = e => {
        if (t !== this.token || e.error === 'interrupted' || e.error === 'canceled') return;
        // Voice can't handle this speed: remember its limit and retry the same sentence slower.
        if (v && u.rate > 2 && !learnedCaps[v.name]) { learnedCaps[v.name] = 2; return this.speak(); }
        this.idx++; this.offset = 0; this.speak();
      };
      this.utter = u; // keep a reference so it is not garbage-collected mid-speech
      this.applied = { rate: S.rate, voice: S.voice };
      setTimeout(() => { if (t === this.token) speechSynthesis.speak(u); }, 40);
      this.setKeepAlive(v && v.localService === false);
      updatePlayer();
    },

    // Online voices in Chrome stop after ~15s unless nudged.
    setKeepAlive(on) {
      clearInterval(this.keepAlive);
      if (!on) return;
      this.keepAlive = setInterval(() => {
        if (this.state === 'playing' && speechSynthesis.speaking) { speechSynthesis.pause(); speechSynthesis.resume(); }
      }, 9000);
    },

    pause() {
      if (this.state !== 'playing') return;
      this.token++;
      this.offset = clamp(this.boundary, 0, (this.chunks[this.idx] || '').length);
      speechSynthesis.cancel();
      clearInterval(this.keepAlive);
      this.state = 'paused';
      updatePlayer();
    },
    resume() {
      if (this.state === 'done') { this.idx = 0; this.offset = 0; }
      if (!this.chunks.length) return;
      this.state = 'playing';
      this.speak();
    },
    toggle() { this.state === 'playing' ? this.pause() : this.resume(); },
    restart() { // re-speak from the current word with new voice/speed
      if (this.state !== 'playing') { updatePlayer(); return; }
      this.offset = clamp(this.boundary, 0, (this.chunks[this.idx] || '').length);
      this.speak();
    },
    jump(delta) {
      if (!this.chunks.length) return;
      if (delta < 0 && this.boundary - this.offset > 25) delta = 0; // first press restarts sentence
      this.idx = clamp(this.idx + delta, 0, this.chunks.length - 1);
      this.offset = 0; this.boundary = 0;
      if (this.state === 'playing') this.speak();
      else { if (this.state === 'done') this.state = 'paused'; updatePlayer(); }
    },
    finish() {
      this.token++;
      clearInterval(this.keepAlive);
      this.state = 'done';
      this.idx = this.chunks.length; this.offset = 0;
      updatePlayer();
    },
    stop() {
      this.token++;
      clearInterval(this.keepAlive);
      speechSynthesis.cancel();
      this.state = 'idle';
      this.chunks = [];
      hidePlayer();
    }
  };
  window.addEventListener('pagehide', () => speechSynthesis.cancel());

  /* ---------------- icons ---------------- */
  const I = {
    speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zM19 5.5v13L9.5 12z" fill="currentColor"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M16 5h2v14h-2zM5 5.5v13L14.5 12z" fill="currentColor"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    grip: '<svg viewBox="0 0 10 16"><g fill="currentColor"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></g></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
  };
  function avatar(p, size = '') {
    if (p.id === 'jarvis') {
      return `<span class="av jarvis ${size}" style="--c:${p.color}"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".45"/><circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="3 1.6"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/></svg></span>`;
    }
    return `<span class="av ${size}" style="--c:${p.color}">${p.name[0]}</span>`;
  }

  /* ---------------- UI (Shadow DOM so pages can't break the styling) ---------------- */
  const host = document.createElement('div');
  host.id = ROOT_ID;
  host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
  <style>
    :host{all:initial}
    *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
    .hidden{display:none!important}
    button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
    svg{display:block;width:100%;height:100%}
    .card{background:#fff;color:#1c1c28;border-radius:16px;box-shadow:0 14px 44px rgba(18,18,60,.22),0 0 0 1px rgba(10,10,40,.07)}
    @keyframes pop{from{transform:scale(.85) translateY(4px);opacity:0}to{transform:none;opacity:1}}

    .bubble{position:fixed;display:flex;align-items:stretch;height:34px;border-radius:999px;overflow:hidden;
      background:linear-gradient(135deg,#6d5cff,#2fa8ff);color:#fff;font-size:13px;font-weight:600;letter-spacing:.1px;
      box-shadow:0 8px 22px rgba(60,70,200,.38);animation:pop .14s ease-out;white-space:nowrap}
    .bubble button{display:flex;align-items:center;gap:7px;color:#fff;font-weight:600}
    .bmain{padding:0 11px 0 10px}
    .bopt{width:28px;justify-content:center;padding:0 7px 0 5px;border-left:1px solid rgba(255,255,255,.35)!important}
    .bubble button:hover{background:rgba(255,255,255,.16)}
    .bubble .ic{width:18px;height:18px}

    .menu{position:fixed;width:300px;padding:14px;animation:pop .15s ease-out}
    .mh{display:flex;align-items:center;gap:8px;margin-bottom:10px}
    .mh .ic{width:20px;height:20px;color:#6d5cff}
    .mh b{font-size:15px;flex:1}
    .xbtn{width:26px;height:26px;border-radius:8px;padding:6px;color:#777}
    .xbtn:hover{background:#f0f0f6;color:#222}
    .label{font-size:11px;font-weight:700;color:#8a8aa0;text-transform:uppercase;letter-spacing:.6px;margin:4px 2px 6px}
    .vlist{display:flex;flex-direction:column;gap:4px}
    .vrow{display:flex;align-items:center;gap:10px;width:100%;padding:7px 9px;border-radius:11px;text-align:left;border:1.5px solid transparent}
    .vrow:hover{background:#f4f4fa}
    .vrow.sel{background:#f1efff;border-color:#8f84ff}
    .vrow .t{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.2}
    .vrow .t b{font-size:13.5px}
    .vrow .t small{font-size:11.5px;color:#7a7a90;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .g{font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:99px;background:#ffe6f1;color:#d63c80}
    .g.male{background:#e2f2ff;color:#1f7fcf}
    .ok{width:16px;height:16px;color:#6d5cff;visibility:hidden}
    .vrow.sel .ok{visibility:visible}
    .av{flex:none;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;
      background:var(--c);color:#fff;font-weight:700;font-size:14px;box-shadow:inset 0 -3px 6px rgba(0,0,0,.12)}
    .av.jarvis{background:radial-gradient(circle,#0d2a44 0%,#06121f 75%);color:var(--c);padding:3px;box-shadow:0 0 10px rgba(54,184,255,.65),inset 0 0 6px rgba(54,184,255,.5)}
    .av.sm{width:30px;height:30px;font-size:13px}

    .speed{margin-top:12px}
    .srow{display:flex;align-items:center;gap:10px}
    .srow input{flex:1;accent-color:#6d5cff;height:18px;cursor:pointer}
    .sval{min-width:46px;text-align:right;font-weight:700;font-size:13px;color:#4b3fe0}
    .chips{display:flex;gap:5px;margin-top:7px;flex-wrap:wrap;justify-content:space-between}
    .chip{font-size:11.5px;font-weight:600;padding:4px 9px;border-radius:99px;background:#f1f1f7;color:#444}
    .chip:hover{background:#e6e4ff}
    .chip.on{background:#6d5cff;color:#fff}
    .go{margin-top:13px;width:100%;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;gap:8px;
      background:linear-gradient(135deg,#6d5cff,#2fa8ff);color:#fff;font-weight:700;font-size:14px;box-shadow:0 6px 16px rgba(80,90,230,.3)}
    .go:hover{filter:brightness(1.07)}
    .go .ic{width:18px;height:18px}

    .player{position:fixed;width:340px;padding:9px 10px 10px;user-select:none;touch-action:none;cursor:grab;animation:pop .16s ease-out}
    .player.drag{cursor:grabbing;box-shadow:0 20px 50px rgba(18,18,60,.3),0 0 0 1px rgba(10,10,40,.08)}
    .player.jv{box-shadow:0 14px 44px rgba(18,18,60,.22),0 0 0 1.5px rgba(54,184,255,.55),0 0 18px rgba(54,184,255,.25)}
    .row{display:flex;align-items:center;gap:6px}
    .grip{width:10px;height:16px;color:#c3c3d3;flex:none;margin-right:1px}
    .who{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.15;margin-left:3px}
    .who b{font-size:13.5px}
    .who small{font-size:11px;color:#8a8aa0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .who b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .who small.live{color:#2fa36b}
    .ctl{width:30px;height:30px;border-radius:50%;padding:7px;color:#444;flex:none}
    .ctl:hover{background:#f0f0f7;color:#111}
    .ctl.main{width:38px;height:38px;padding:10px;background:linear-gradient(135deg,#6d5cff,#2fa8ff);color:#fff;box-shadow:0 4px 12px rgba(80,90,230,.35)}
    .ctl.main:hover{filter:brightness(1.08)}
    .spd{flex:none;height:28px;min-width:48px;padding:0 8px;border-radius:9px;background:#f1f1f7;font-size:12.5px;font-weight:700;color:#333}
    .spd:hover{background:#e6e4ff;color:#4b3fe0}
    .avb{border-radius:50%}
    .avb:hover .av{transform:scale(1.07)}
    .cap{margin-top:7px;font-size:12px;line-height:1.4;color:#55556a;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:17px;padding:0 2px}
    .prog{margin-top:7px;height:4px;border-radius:9px;background:#ececf4;overflow:hidden}
    .prog i{display:block;height:100%;width:0;background:linear-gradient(90deg,#6d5cff,#2fa8ff);border-radius:9px;transition:width .25s}

    .pop{position:fixed;width:280px;padding:12px;animation:pop .14s ease-out}

    @media (prefers-color-scheme:dark){
      .card{background:#1e1e2a;color:#ececf6;box-shadow:0 14px 44px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.08)}
      .vrow:hover,.xbtn:hover,.ctl:hover{background:#2b2b3a}
      .vrow.sel{background:#2b2850;border-color:#8f84ff}
      .vrow .t small,.who small,.label{color:#9a9ab2}
      .ctl{color:#d6d6e6}.xbtn{color:#aaa}
      .spd,.chip{background:#2c2c3c;color:#ddd}
      .prog{background:#2c2c3c}.cap{color:#b4b4c8}.grip{color:#55556a}
      .g{background:#4a2338;color:#ff8fc0}.g.male{background:#1e3550;color:#7cc3ff}
    }
  </style>
  <div class="bubble hidden">
    <button class="bmain" data-act="readNow" title="Read aloud with your saved voice &amp; speed"><span class="ic">${I.speaker}</span>Read aloud</button>
    <button class="bopt" data-act="openMenu" title="Choose voice &amp; speed"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10l5 5 5-5"/></svg></button>
  </div>

  <div class="menu card hidden">
    <div class="mh"><span class="ic">${I.speaker}</span><b>Read aloud</b><button class="xbtn" data-act="closeMenu" title="Close">${I.close}</button></div>
    <div class="label">Choose a voice</div>
    <div class="vlist" data-list="menu"></div>
    <div class="speed">
      <div class="label">Speed</div>
      <div class="srow"><input type="range" min="0.5" max="3" step="0.05" data-rate-slider><span class="sval"></span></div>
      <div class="chips" data-chips></div>
    </div>
    <button class="go" data-act="readSel"><span class="ic">${I.play}</span><span class="golabel">Read aloud</span></button>
  </div>

  <div class="player card hidden">
    <div class="row">
      <span class="grip" title="Drag to move">${I.grip}</span>
      <button class="avb" data-act="voicesPop" title="Change voice"></button>
      <div class="who"><b class="pname"></b><small class="pstate"></small></div>
      <button class="ctl" data-act="prev" title="Previous sentence">${I.prev}</button>
      <button class="ctl main" data-act="toggle" title="Pause / Play"></button>
      <button class="ctl" data-act="next" title="Next sentence">${I.next}</button>
      <button class="spd" data-act="speedPop" title="Reading speed"></button>
      <button class="ctl" data-act="stop" title="Stop &amp; close">${I.close}</button>
    </div>
    <div class="cap"></div>
    <div class="prog"><i></i></div>
  </div>

  <div class="pop card hidden" data-pop="voices">
    <div class="mh"><b>Voice</b><button class="xbtn" data-act="closePops">${I.close}</button></div>
    <div class="vlist" data-list="pop"></div>
  </div>
  <div class="pop card hidden" data-pop="speed">
    <div class="mh"><b>Reading speed</b><button class="xbtn" data-act="closePops">${I.close}</button></div>
    <div class="srow"><input type="range" min="0.5" max="3" step="0.05" data-rate-slider><span class="sval"></span></div>
    <div class="chips" data-chips></div>
  </div>`;
  document.documentElement.appendChild(host);
  new MutationObserver(() => { if (!host.isConnected) document.documentElement.appendChild(host); })
    .observe(document.documentElement, { childList: true });

  const $ = s => root.querySelector(s);
  const $$ = s => [...root.querySelectorAll(s)];
  const bubble = $('.bubble'), menu = $('.menu'), player = $('.player');
  const pops = { voices: $('[data-pop="voices"]'), speed: $('[data-pop="speed"]') };
  const RATE_CHIPS = [0.75, 1, 1.25, 1.5, 2, 3];

  function voiceListHTML() {
    return VR.PRESETS.map(p => {
      const v = voiceMap[p.id];
      const sys = v ? v.name.replace(/^Microsoft\s+|\s*-\s*English.*$|\s*\(.*?\)\s*$/g, '').trim() : 'default voice';
      return `<button class="vrow ${S.voice === p.id ? 'sel' : ''}" data-voice="${p.id}">
        ${avatar(p, 'sm')}
        <span class="t"><b>${p.name}</b><small>${esc(p.tag)} · ${esc(sys)}</small></span>
        <span class="g ${p.gender}">${p.gender === 'male' ? 'Male' : 'Female'}</span>
        <span class="ok">${I.check}</span>
      </button>`;
    }).join('');
  }

  function renderAll() {
    $$('[data-list]').forEach(el => { el.innerHTML = voiceListHTML(); });
    $$('[data-rate-slider]').forEach(el => { el.value = S.rate; });
    $$('.sval').forEach(el => { el.textContent = fmtRate(S.rate); });
    $$('[data-chips]').forEach(el => {
      el.innerHTML = RATE_CHIPS.map(r => `<button class="chip ${Math.abs(S.rate - r) < 0.001 ? 'on' : ''}" data-rate="${r}">${r}x</button>`).join('');
    });
    $('.golabel').textContent = `Read with ${VR.preset(S.voice).name}`;
    updatePlayer();
  }

  function updatePlayer() {
    const p = VR.preset(S.voice);
    $('.avb').innerHTML = avatar(p);
    $('.pname').textContent = p.name;
    player.classList.toggle('jv', p.id === 'jarvis');
    const st = $('.pstate');
    const labels = { playing: 'Reading…', paused: 'Paused', done: 'Finished · tap ▶ to replay', idle: 'Ready' };
    st.textContent = labels[R.state] + (R.state === 'playing' && R.capped ? ` · voice max ${R.capped}x` : '');
    st.classList.toggle('live', R.state === 'playing');
    $('[data-act="toggle"]').innerHTML = R.state === 'playing' ? I.pause : I.play;
    $('.spd').textContent = fmtRate(S.rate);
    $('.cap').textContent = R.chunks[Math.min(R.idx, R.chunks.length - 1)] || '';
    updateProgress();
  }
  function updateProgress() {
    let pct = 0;
    if (R.total) pct = R.state === 'done' ? 100 : ((R.cum[R.idx] || 0) + (R.boundary || 0)) / R.total * 100;
    $('.prog i').style.width = clamp(pct, 0, 100) + '%';
  }

  /* ---------------- player position & dragging ---------------- */
  function placePlayer() {
    if (player.classList.contains('hidden')) return;
    const w = player.offsetWidth || 340, h = player.offsetHeight || 90;
    let x, y;
    if (S.pos && typeof S.pos.x === 'number') { x = S.pos.x; y = S.pos.y; }
    else { x = innerWidth - w - 24; y = innerHeight - h - 24; }
    x = clamp(x, 6, Math.max(6, innerWidth - w - 6));
    y = clamp(y, 6, Math.max(6, innerHeight - h - 6));
    player.style.left = x + 'px'; player.style.top = y + 'px';
  }
  function showPlayer() { closeMenu(); hideBubble(); player.classList.remove('hidden'); placePlayer(); updatePlayer(); }
  function hidePlayer() { player.classList.add('hidden'); closePops(); }
  addEventListener('resize', placePlayer);

  let drag = null;
  player.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button,input')) return;
    const r = player.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
    player.setPointerCapture(e.pointerId);
    player.classList.add('drag');
    closePops();
    e.preventDefault();
  });
  player.addEventListener('pointermove', e => {
    if (!drag) return;
    const x = clamp(e.clientX - drag.dx, 4, innerWidth - player.offsetWidth - 4);
    const y = clamp(e.clientY - drag.dy, 4, innerHeight - player.offsetHeight - 4);
    player.style.left = x + 'px'; player.style.top = y + 'px';
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    player.classList.remove('drag');
    save({ pos: { x: parseFloat(player.style.left), y: parseFloat(player.style.top) } });
  };
  player.addEventListener('pointerup', endDrag);
  player.addEventListener('pointercancel', endDrag);

  /* ---------------- popovers next to the player ---------------- */
  function openPop(name) {
    const el = pops[name];
    const wasOpen = !el.classList.contains('hidden');
    closePops();
    if (wasOpen) return;
    el.classList.remove('hidden');
    const pr = player.getBoundingClientRect();
    const h = el.offsetHeight, w = el.offsetWidth;
    let top = pr.top - h - 8;
    if (top < 6) top = pr.bottom + 8;
    top = clamp(top, 6, innerHeight - h - 6);
    const left = clamp(pr.right - w, 6, innerWidth - w - 6);
    el.style.left = left + 'px'; el.style.top = top + 'px';
  }
  function closePops() { Object.values(pops).forEach(p => p.classList.add('hidden')); }

  /* ---------------- selection bubble & menu ---------------- */
  let selText = '';
  let bubblePos = { x: 0, y: 0 };

  function getSelectedText() {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'TEXTAREA' || (ae.tagName === 'INPUT' && /^(text|search|url|email|tel)$/i.test(ae.type)))) {
      try {
        const s = ae.value.substring(ae.selectionStart, ae.selectionEnd);
        if (s.trim()) return s.trim();
      } catch (e) {}
    }
    return (window.getSelection()?.toString() || '').trim();
  }
  function selectionRect() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const rects = sel.getRangeAt(0).getClientRects();
    const r = rects[rects.length - 1] || sel.getRangeAt(0).getBoundingClientRect();
    return r && (r.width || r.height) ? r : null;
  }
  function getPageText() {
    const el = document.querySelector('article') || document.querySelector('main,[role="main"]') || document.body;
    return el ? el.innerText : '';
  }

  function showBubble(x, y) {
    bubble.classList.remove('hidden');
    const w = bubble.offsetWidth || 120, h = bubble.offsetHeight || 34;
    let left = x + 8, top = y + 12;
    if (left + w > innerWidth - 6) left = x - w - 8;
    if (top + h > innerHeight - 6) top = y - h - 12;
    left = clamp(left, 6, innerWidth - w - 6); top = clamp(top, 6, innerHeight - h - 6);
    bubble.style.left = left + 'px'; bubble.style.top = top + 'px';
    bubblePos = { x: left, y: top, h };
  }
  function hideBubble() { bubble.classList.add('hidden'); }
  function openMenu() {
    renderAll();
    menu.classList.remove('hidden');
    hideBubble();
    const w = menu.offsetWidth, h = menu.offsetHeight;
    let top = bubblePos.y + bubblePos.h + 6;
    if (top + h > innerHeight - 6) top = bubblePos.y - h - 6;
    top = clamp(top, 6, Math.max(6, innerHeight - h - 6));
    const left = clamp(bubblePos.x, 6, innerWidth - w - 6);
    menu.style.left = left + 'px'; menu.style.top = top + 'px';
  }
  function closeMenu() { menu.classList.add('hidden'); }
  const menuOpen = () => !menu.classList.contains('hidden');

  function maybeShowBubble(x, y, useRect) {
    if (!S.showBubble) return;
    const text = getSelectedText();
    if (text.length < 2) { if (!menuOpen()) hideBubble(); return; }
    selText = text;
    if (useRect) { const r = selectionRect(); if (r) { x = r.right; y = r.bottom; } }
    showBubble(x, y);
  }

  const inUI = e => e.composedPath().includes(host);
  document.addEventListener('mouseup', e => {
    if (e.button !== 0 || inUI(e)) return;
    const x = e.clientX, y = e.clientY;
    setTimeout(() => maybeShowBubble(x, y, false), 10);
  }, true);
  document.addEventListener('keyup', e => {
    if (inUI(e)) return;
    if (e.key === 'Escape') { closeMenu(); closePops(); hideBubble(); return; }
    if (e.shiftKey && /^(Arrow|Home|End|Page)/.test(e.key)) maybeShowBubble(0, 0, true);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') maybeShowBubble(innerWidth / 2, innerHeight / 3, false);
  }, true);
  document.addEventListener('mousedown', e => {
    if (inUI(e)) return;
    hideBubble(); closeMenu(); closePops();
  }, true);
  let lastUIPress = 0;
  const justPressedUI = () => Date.now() - lastUIPress < 600;
  document.addEventListener('scroll', () => { if (!justPressedUI()) hideBubble(); }, { capture: true, passive: true });
  document.addEventListener('selectionchange', () => {
    if (justPressedUI()) return;
    setTimeout(() => {
      if (!justPressedUI() && !menuOpen() && !bubble.classList.contains('hidden') && !getSelectedText()) hideBubble();
    }, 150);
  });
  root.addEventListener('keyup', e => { if (e.key === 'Escape') { closeMenu(); closePops(); } });

  // Keep the page's text highlighted when clicking our buttons, and keep the page's own
  // click handlers (e.g. TryHackMe) from reacting to clicks on our UI.
  root.addEventListener('mousedown', e => { if (!e.target.closest('input')) e.preventDefault(); e.stopPropagation(); });
  ['mouseup', 'click', 'pointerup', 'touchstart', 'touchend'].forEach(t => root.addEventListener(t, e => e.stopPropagation()));
  root.addEventListener('pointerdown', e => {
    lastUIPress = Date.now();
    e.stopPropagation();
    const act = e.target.closest('.bubble [data-act]')?.dataset.act;
    if (!act || e.button > 0) return;
    e.preventDefault();
    if (act === 'readNow') {               // read straight away with the saved voice & speed
      const t = selText || getSelectedText();
      hideBubble();
      if (t) R.start(t);
    } else if (act === 'openMenu') {
      openMenu();
    }
  });

  /* ---------------- clicks ---------------- */
  root.addEventListener('click', e => {
    const voiceBtn = e.target.closest('[data-voice]');
    if (voiceBtn) {
      save({ voice: voiceBtn.dataset.voice });
      renderAll();
      if (voiceBtn.closest('[data-pop]')) { closePops(); R.restart(); }
      return;
    }
    const rateBtn = e.target.closest('[data-rate]');
    if (rateBtn) { setRate(parseFloat(rateBtn.dataset.rate), true); return; }

    const act = e.target.closest('[data-act]')?.dataset.act;
    switch (act) {
      case 'closeMenu': closeMenu(); break;
      case 'readSel': if (selText) R.start(selText); closeMenu(); break;
      case 'toggle': R.toggle(); break;
      case 'prev': R.jump(-1); break;
      case 'next': R.jump(1); break;
      case 'stop': R.stop(); break;
      case 'voicesPop': openPop('voices'); break;
      case 'speedPop': openPop('speed'); break;
      case 'closePops': closePops(); break;
    }
  });

  function setRate(r, apply) {
    r = clamp(Math.round(r * 100) / 100, 0.5, 3);
    save({ rate: r });
    renderAll();
    if (apply) R.restart();
  }
  root.addEventListener('input', e => {
    if (e.target.matches('[data-rate-slider]')) {
      S.rate = parseFloat(e.target.value);
      $$('.sval').forEach(el => { el.textContent = fmtRate(S.rate); });
      $('.spd').textContent = fmtRate(S.rate);
    }
  });
  root.addEventListener('change', e => {
    if (e.target.matches('[data-rate-slider]')) setRate(parseFloat(e.target.value), true);
  });

  /* ---------------- messages from toolbar popup, right-click menu, shortcuts ---------------- */
  chrome.runtime.onMessage.addListener((m, _s, reply) => {
    switch (m && m.type) {
      case 'read': {
        const t = (m.text || '').trim() || getSelectedText() || (m.pageFallback ? getPageText() : '');
        if (t) R.start(t);
        break;
      }
      case 'readPage': R.start(getPageText()); break;
      case 'toggle':
        if (R.state === 'idle') { const t = getSelectedText(); if (t) R.start(t); }
        else R.toggle();
        break;
      case 'stop': R.stop(); break;
    }
    reply({ ok: true, state: R.state });
  });

  renderAll();
})();
