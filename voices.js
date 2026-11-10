// Shared voice logic: presets, voice matching and text chunking.
// Used by both the page script (content.js) and the toolbar popup.
(() => {
  if (globalThis.VR) return;

  // The 5 voice presets. Each one is matched to the best free voice your
  // browser/OS provides, then shaped with pitch + rate so they sound distinct.
  const PRESETS = [
    {
      id: 'aria', name: 'Ayesha', gender: 'female', lang: 'en-US', tag: 'Warm American',
      color: '#ff5fa2', pitch: 1.0, rate: 1.0,
      prefer: [/\baria\b.*natural/i, /\bjenny\b.*natural/i, /\bava\b.*natural/i, /^google us english$/i,
               /\bsamantha\b/i, /\bava\b/i, /\ballison\b/i, /\bzira\b/i]
    },
    {
      id: 'sophie', name: 'Khadija', gender: 'female', lang: 'en-GB', tag: 'Elegant British',
      color: '#9b6bff', pitch: 1.05, rate: 1.0,
      prefer: [/\bsonia\b.*natural/i, /\blibby\b.*natural/i, /\bmaisie\b.*natural/i, /google uk english female/i,
               /\bserena\b/i, /\bkate\b/i, /\bstephanie\b/i, /\bmartha\b/i, /\bhazel\b/i]
    },
    {
      id: 'luna', name: 'Zainab', gender: 'female', lang: 'en-AU', tag: 'Soft & calm',
      color: '#2fc4b2', pitch: 1.12, rate: 0.95,
      prefer: [/\bmichelle\b.*natural/i, /\bnatasha\b.*natural/i, /\bemma\b.*natural/i, /\bclara\b.*natural/i,
               /\bkaren\b/i, /\btessa\b/i, /\bmoira\b/i, /\bfiona\b/i, /\bsusan\b/i, /\bvictoria\b/i]
    },
    {
      id: 'jarvis', name: 'Jarvis', gender: 'male', lang: 'en-GB', tag: 'British AI butler',
      color: '#36b8ff', pitch: 0.82, rate: 1.05,
      prefer: [/\bryan\b.*natural/i, /\bthomas\b.*natural/i, /google uk english male/i, /\bdaniel\b/i,
               /\bgeorge\b/i, /\barthur\b/i, /\boliver\b/i, /\bmalcolm\b/i]
    },
    {
      id: 'max', name: 'Robot', gender: 'male', lang: 'en-US', tag: 'Confident American',
      color: '#ff9a3c', pitch: 0.95, rate: 1.0,
      prefer: [/\bguy\b.*natural/i, /\bandrew\b.*natural/i, /\bchristopher\b.*natural/i, /\beric\b.*natural/i,
               /\bbrian\b.*natural/i, /\baaron\b/i, /\balex\b/i, /\bdavid\b/i, /\bmark\b/i, /\btom\b/i, /\bfred\b/i]
    }
  ];

  const FEMALE = /\b(female|zira|hazel|susan|aria|jenny|ava|samantha|karen|moira|tessa|victoria|fiona|libby|sonia|natasha|michelle|emma|clara|serena|kate|stephanie|martha|allison|catherine|linda|joanna|salli|kimberly|ivy|kendra|amy|emily|olivia|nicky|veena|neerja|heera|jane|nancy|sara|elizabeth|ashley|cora|monica|aditi|maisie|bella|hollie|abbi|isla|zoe|evie|shelley|sandy|flo|vicki|grandma|ana|ava)\b/i;
  const MALE = /\b(male|david|mark|george|guy|ryan|daniel|alex|fred|thomas|arthur|oliver|christopher|eric|andrew|brian|aaron|james|richard|william|liam|prabhat|ravi|rishi|sean|connor|mitchell|roger|steffan|tony|jason|brandon|matthew|joey|justin|kevin|russell|malcolm|gordon|lee|tom|reed|rocko|eddy|alfie|elliot|ethan|noah|hugo|harry|jacob|kenneth|davis|grandpa)\b/i;
  const NOVELTY = /\b(bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|albert|junior|ralph|kathy|princess|deranged|hysterical)\b/i;

  function gender(v) {
    const n = v.name || '';
    if (/google us english/i.test(n)) return 'female';
    if (/\bfemale\b/i.test(n)) return 'female';
    if (/\bmale\b/i.test(n)) return 'male';
    if (FEMALE.test(n)) return 'female';
    if (MALE.test(n)) return 'male';
    return null;
  }

  function preset(id) {
    return PRESETS.find(p => p.id === id) || PRESETS[0];
  }

  // Map each preset -> a SpeechSynthesisVoice, trying to give every preset a different voice.
  function resolve(all, overrides = {}) {
    all = (all || []).filter(v => !NOVELTY.test(v.name));
    const en = all.filter(v => /^en/i.test(v.lang));
    const pool = en.length ? en : all;
    const used = new Set();
    const out = {};

    for (const p of PRESETS) {
      const name = overrides && overrides[p.id];
      if (name) {
        const v = all.find(x => x.name === name);
        if (v) { out[p.id] = v; used.add(v.name); }
      }
    }

    for (const p of PRESETS) {
      if (out[p.id]) continue;
      const free = v => !used.has(v.name);
      const sameLang = v => (v.lang || '').replace('_', '-').toLowerCase() === p.lang.toLowerCase();
      let pick = null;
      for (const re of p.prefer) { pick = pool.find(v => re.test(v.name) && free(v)); if (pick) break; }
      if (!pick) pick = pool.find(v => gender(v) === p.gender && sameLang(v) && free(v));
      if (!pick) pick = pool.find(v => gender(v) === p.gender && free(v));
      if (!pick) for (const re of p.prefer) { pick = pool.find(v => re.test(v.name)); if (pick) break; }
      if (!pick) pick = pool.find(v => gender(v) === p.gender);
      if (!pick) pick = pool.find(v => free(v) && v.default) || pool.find(free) || pool[0] || null;
      if (pick) used.add(pick.name);
      out[p.id] = pick;
    }
    return out;
  }

  // Split text into smooth, natural chunks (sentences), never too long.
  // Short chunks avoid Chrome's habit of cutting speech off after ~15 seconds.
  function chunk(text, max = 180) {
    const paragraphs = String(text || '').split(/\n\s*\n|\r?\n/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const out = [];
    for (const para of paragraphs) {
      const sentences = para.match(/[^.!?。！？]+(?:[.!?。！？]+["'”’)\]]*|$)\s*/g) || [para];
      const pieces = [];
      for (let s of sentences) {
        s = s.trim();
        if (!s) continue;
        while (s.length > max) {
          let cut = Math.max(s.lastIndexOf(', ', max), s.lastIndexOf('; ', max), s.lastIndexOf(': ', max));
          if (cut < max * 0.4) cut = s.lastIndexOf(' ', max);
          if (cut < max * 0.3) cut = max - 1;
          pieces.push(s.slice(0, cut + 1).trim());
          s = s.slice(cut + 1).trim();
        }
        if (s) pieces.push(s);
      }
      // merge tiny fragments within the same paragraph for smoother flow
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

  function getVoices() {
    return new Promise(resolve => {
      if (typeof speechSynthesis === 'undefined') return resolve([]);
      let v = speechSynthesis.getVoices();
      if (v.length) return resolve(v);
      const done = () => { speechSynthesis.removeEventListener('voiceschanged', done); resolve(speechSynthesis.getVoices()); };
      speechSynthesis.addEventListener('voiceschanged', done);
      setTimeout(done, 2500);
    });
  }

  globalThis.VR = { PRESETS, preset, gender, resolve, chunk, getVoices };
})();
