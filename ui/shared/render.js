/* Widget renderer shared by the widget window and the dashboard's live preview.
 * Global: AM_RENDER */
(function (root) {
  'use strict';
  const U = root.AM_UTIL;
  const LOGOS = root.AM_LOGOS || {};
  const esc = U.esc;
  const I18N = root.AM_I18N;
  const tr = (k, v) => I18N.t(k, v);

  function logo(id, size) {
    return `<span class="logo ${esc(id)}" style="width:${size}px;height:${size}px">${LOGOS[id] || ''}</span>`;
  }

  function meter(w, settings, opts = {}) {
    const sev = U.severity(w.usedPercent, settings.alertThresholds);
    const val = Math.min(100, U.shown(w, settings));
    // the tick sits where the bar would be at an even pace: elapsed share of the window
    // when showing use, the share still to go when showing what's left
    const at = settings.valueMode === 'remaining' ? 1 - w.elapsed : w.elapsed;
    const pace = opts.pace && w.elapsed != null ? `<b class="pace" style="left:${(Math.max(0, Math.min(1, at)) * 100).toFixed(1)}%"></b>` : '';
    return `<div class="meter sev-${sev}${opts.cls ? ` ${opts.cls}` : ''}"><i style="width:${val.toFixed(1)}%"></i>${pace}</div>`;
  }

  function resetText(w, settings, now, short) {
    if (!w.resetsAt) return w.stale ? (short ? '↻--' : tr('w.resetDone')) : '';
    const left = w.resetsAt - now;
    if (settings.resetFormat === 'clock') return short ? `↻${U.fmtClock(w.resetsAt, now)}` : tr('w.resetAt', { t: U.fmtClock(w.resetsAt, now) });
    return short ? `↻${U.fmtShortLeft(left)}` : tr('w.resetIn', { t: U.fmtLeft(left) });
  }

  function forecastText(w, now) {
    if (!w.exhaustBeforeReset || !w.eta) return '';
    return tr('w.forecast', { t: U.fmtLeft(w.eta - now) });
  }

  /** Plain-text tooltip for a provider (used in the docked widget). */
  function tooltip(p, settings, now) {
    const lines = [`${p.name}${p.plan ? ` · ${p.plan}` : ''}`];
    for (const w of p.windows || []) {
      const used = Math.round(w.usedPercent);
      let line = tr('w.tipLine', { label: w.label, used, left: 100 - used });
      if (w.resetsAt) line += tr('w.tipReset', { at: U.fmtDateTime(w.resetsAt), in: U.fmtLeft(w.resetsAt - now) });
      else if (w.source === 'estimate') line += tr('w.tipEstimate');
      lines.push(line);
      const fc = forecastText(w, now);
      if (fc) lines.push(tr('w.tipForecast', { fc }));
      else if (w.ratePerHour) lines.push(tr('w.tipRate', { r: w.ratePerHour.toFixed(1) }));
    }
    const t = p.tokens || {};
    lines.push(tr('w.tipToday', { n: U.fmtNum(t.today), cost: U.fmtMoney(t.costToday) }));
    if (p.apiError) lines.push(`! ${I18N.apiError(p.apiError)}`);
    return lines.join('\n');
  }

  /** A little speech bubble when an agent's tightest shown limit is nearly out (≤ 5% left)
   * or gone (0%). Windows without a reading or already reset don't count.
   * The bubble shows once per crossing for MEME_MS, fading in and out; re-renders in between
   * pick the animation up where it is (negative delay), so it never restarts or flickers. */
  const MEME_MS = 5000;
  const memeSeen = {}; // provider id -> { level: 'hot' | 'done', at }
  let memeNew = 0; // bubbles that started since the last takeMemeEvents()

  function memeLevel(ws) {
    let least = null;
    for (const w of ws) {
      if (w.stale || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) continue;
      const left = Math.max(0, 100 - w.usedPercent);
      if (least === null || left < least) least = left;
    }
    if (least === null || least > 5) return '';
    return least <= 0 ? 'done' : 'hot';
  }

  function meme(p, ws, now) {
    // an agent in the middle of its own chaos keeps quiet: the quip speaks for it, and the
    // bubble starts fresh (full 5 s) once the chaos is over
    if (moodFx.chaos && moodFx.chaos.id === p.id) return '';
    const level = memeLevel(ws);
    const seen = memeSeen[p.id];
    if (!level) {
      delete memeSeen[p.id];
      return '';
    }
    if (!seen || seen.level !== level) {
      memeSeen[p.id] = { level, at: now };
      memeNew++;
    }
    const age = now - memeSeen[p.id].at;
    if (age < 0 || age >= MEME_MS) return '';
    const done = level === 'done';
    return `<span class="meme${done ? ' done' : ''}" style="animation-delay:-${age}ms">${esc(tr(done ? 'w.meme.done' : 'w.meme.hot'))}</span>`;
  }

  /** How many bubbles appeared since the last call (the widget plays a sound for them). */
  function takeMemeEvents() {
    const n = memeNew;
    memeNew = 0;
    return n;
  }

  // ------------------------------------------------------------------ agent moods
  // Playful life for the floating card only: the strip stays calm so it never gets in the
  // way of the taskbar. Two separate repertoires, each with its own motions and lines:
  //   * POKES — only when you click an agent: an instant reaction to the touch (blush,
  //     startle, tickle, grumble, a shy heart).
  //   * ENCOUNTERS — on their own while the card sits there: dozing off (mostly at night),
  //     a cold sweat, a dizzy spell, a little cheer. Nothing else: the chaos encounter is not
  //     part of the random repertoire. It belongs to one moment only — a limit that hits 0%:
  //     the agent's block bounces and its logo whirs round, everything stops dead for 3 s,
  //     then one flat quip ("ㅋㅋ" in Korean, "bruh." otherwise), and the 0% bubble follows.
  // Only the preview in the settings page can bring chaos up on demand (PREVIEW_ENCOUNTERS).
  // Every stage is keyed to elapsed time, so a re-render in the middle picks the animation up
  // where it is instead of restarting it (the widget re-renders on stage boundaries).
  const CHAOS_FIT = 1800; // bounce + spin
  const CHAOS_STILL = 4800; // everything frozen (3 s of stillness)
  const CHAOS_LINE = 7800; // one quip, then done
  const MOOD_MS = 2600; // a poke or a small encounter
  const ENC_GAP = 3 * 60 * 1000; // at least this long between random encounters
  const ENC_CHANCE = 0.2; // per roll once the gap has passed (the widget renders about every 30 s)
  const ROLL_GAP = 5000; // fast re-renders (the settings preview) roll at most this often
  /** Click reactions. */
  const POKES = [
    { id: 'blush', emoji: '😳', keys: ['w.poke.blush'] },
    { id: 'startle', emoji: '❗', keys: ['w.poke.startle'] },
    { id: 'tickle', emoji: '🤭', keys: ['w.poke.tickle'] },
    { id: 'grumble', emoji: '💢', keys: ['w.poke.grumble'] },
    { id: 'shyheart', emoji: '💗', keys: ['w.poke.shyheart'] },
  ];
  /** Random encounters, each lasting MOOD_MS. Chaos is deliberately missing: it only ever
   *  fires when a limit hits 0% (advanceFx), never at random. */
  const ENCOUNTERS = [
    { id: 'sleep', emoji: '💤', keys: ['w.enc.sleep', 'w.enc.sleep2'] },
    { id: 'sweat', emoji: '💦', keys: ['w.enc.sweat', 'w.enc.sweat2'] },
    { id: 'dizzy', emoji: '💫', keys: ['w.enc.dizzy', 'w.enc.dizzy2'] },
    { id: 'cheer', emoji: '✨', keys: ['w.enc.cheer', 'w.enc.cheer2'] },
  ];
  /** What the settings page steps through: the same repertoire plus chaos, which has no
   *  random chance left, so the preview is the one place it can be called up. */
  const PREVIEW_ENCOUNTERS = [{ id: 'chaos' }, ...ENCOUNTERS];
  /** How likely each encounter is; dozing off takes over at night (22:00–06:00 local). */
  function encounterWeights(now) {
    const h = new Date(now).getHours();
    const night = h >= 22 || h < 6;
    return { sleep: night ? 9 : 1.5, sweat: 3, dizzy: 3, cheer: 3 };
  }
  function weighted(weights) {
    const total = Object.values(weights).reduce((a, w) => a + w, 0);
    let r = Math.random() * total;
    for (const [id, w] of Object.entries(weights)) {
      if ((r -= w) < 0) return id;
    }
    return Object.keys(weights)[0];
  }
  // chaos: {id, at}; mood: {id, at, kind, src: 'poke' | 'enc', emoji, line}.
  // The first random encounter waits a full gap after the app starts.
  const moodFx = { chaos: null, mood: null, lastEnc: Date.now(), lastRoll: 0, cycle: { poke: -1, enc: -1 } };
  const chaosSeen = {}; // provider id -> a 0% limit already got its encounter
  const pickOne = (a) => a[Math.floor(Math.random() * a.length)];

  function startChaos(id, now) {
    if (!id) return false;
    moodFx.chaos = { id, at: now };
    moodFx.mood = null;
    moodFx.lastEnc = now;
    return true;
  }

  function startMood(src, id, now, kind) {
    if (!id) return false;
    const list = src === 'poke' ? POKES : ENCOUNTERS;
    const m = (kind && list.find((x) => x.id === kind)) || pickOne(list);
    moodFx.mood = { id, at: now, kind: m.id, src, emoji: m.emoji, line: pickOne(m.keys) };
    if (src === 'enc') moodFx.lastEnc = now;
    return true;
  }

  function startEncounter(id, now, kind) {
    return kind === 'chaos' ? startChaos(id, now) : startMood('enc', id, now, kind);
  }

  /** Where the chaos encounter is right now (null once it is over). */
  function chaosStage(c, now) {
    const age = now - c.at;
    if (age < CHAOS_FIT) return { stage: 'bounce', age: Math.max(0, age) };
    if (age < CHAOS_STILL) return { stage: 'still', age };
    if (age < CHAOS_LINE) return { stage: 'line', age: age - CHAOS_STILL };
    return null;
  }

  /** ms until the chaos encounter's next stage (0 when there is none). */
  function chaosNext(now = Date.now()) {
    if (!moodFx.chaos) return 0;
    const age = now - moodFx.chaos.at;
    for (const t of [CHAOS_FIT, CHAOS_STILL, CHAOS_LINE]) if (age < t) return Math.max(40, t - age);
    return 0;
  }

  /** ms until anything on screen changes stage or ends (0 when nothing runs) — widget.js
   * re-renders then, so a finished reaction leaves and the next stage shows on time. */
  function fxNext(now = Date.now()) {
    const c = chaosNext(now);
    const m = moodFx.mood ? Math.max(40, moodFx.mood.at + MOOD_MS - now) : 0;
    return c && m ? Math.min(c, m) : c || m;
  }

  /** Drop finished effects, spot a limit that just hit 0%, and now and then do something. */
  function advanceFx(list, settings, now) {
    if (moodFx.chaos && !chaosStage(moodFx.chaos, now)) moodFx.chaos = null;
    if (moodFx.mood && now - moodFx.mood.at >= MOOD_MS) moodFx.mood = null;
    if (settings && settings.moods === false) {
      moodFx.chaos = null;
      moodFx.mood = null;
      for (const p of list) delete chaosSeen[p.id];
      return;
    }
    // a limit at 0%: always the chaos encounter, once per drop
    for (const p of list) {
      const done = memeLevel(U.visibleWindows(p, settings, settings.floating)) === 'done';
      if (!done) {
        delete chaosSeen[p.id];
      } else if (!chaosSeen[p.id] && !moodFx.chaos) {
        chaosSeen[p.id] = true;
        // the 0% bubble waits its turn: it starts over once the quip is done, so it gets
        // its whole 5 s instead of draining behind the chaos
        delete memeSeen[p.id];
        startChaos(p.id, now);
      }
    }
    // left alone for a while: a random encounter now and then (never over another one)
    const busy = moodFx.chaos || moodFx.mood;
    if (!busy && list.length && now - moodFx.lastRoll > ROLL_GAP && now - moodFx.lastEnc > ENC_GAP) {
      moodFx.lastRoll = now;
      if (Math.random() < ENC_CHANCE) {
        const kind = weighted(encounterWeights(now));
        startEncounter(pickOne(list).id, now, kind);
      }
    }
  }

  /** A click on an agent in the card (widget.js): one of the click-only reactions. */
  function poke(id, settings, now = Date.now()) {
    if (settings && settings.moods === false) return false;
    if (moodFx.chaos) return false; // the chaos encounter plays out undisturbed
    return startMood('poke', id, now);
  }

  /** The settings page steps through each repertoire, one kind per press. */
  function previewPoke(id, now = Date.now()) {
    moodFx.cycle.poke = (moodFx.cycle.poke + 1) % POKES.length;
    const kind = POKES[moodFx.cycle.poke].id;
    moodFx.chaos = null;
    startMood('poke', id, now, kind);
    return kind;
  }
  /** Step to the next encounter, or play `kind` when one is named (previewEncounter(id, 'chaos')). */
  function previewEncounter(id, now = Date.now(), kind) {
    if (typeof now === 'string') [now, kind] = [Date.now(), now];
    if (!kind) {
      moodFx.cycle.enc = (moodFx.cycle.enc + 1) % PREVIEW_ENCOUNTERS.length;
      kind = PREVIEW_ENCOUNTERS[moodFx.cycle.enc].id;
    }
    moodFx.chaos = null;
    moodFx.mood = null;
    startEncounter(id, now, kind);
    return kind;
  }
  /** Older names, kept for scripts: chaos, and a random click reaction. */
  function previewChaos(id, now = Date.now()) {
    return startChaos(id, now);
  }
  function previewMood(id, now = Date.now()) {
    return startMood('poke', id, now);
  }

  // ------------------------------------------------------------------ today / 7 days
  /** Token and cost figures follow settings.statsPeriod: today, or the last 7 days. */
  const isWeek = (settings) => settings && settings.statsPeriod === 'week';
  const statTokens = (p, settings) => ((p.tokens || {})[isWeek(settings) ? 'week' : 'today']) || 0;
  const statCost = (p, settings) => ((p.tokens || {})[isWeek(settings) ? 'costWeek' : 'costToday']) || 0;
  /** A small calendar showing 1 (today) or 7 (the last 7 days); a click flips it. */
  function periodIcon(week) {
    return `<svg viewBox="0 0 24 24" class="per"><rect x="4" y="5.5" width="16" height="14.5" rx="2.6"/><path d="M4 9.8h16M8.6 3.5v3.6M15.4 3.5v3.6"/><text x="12" y="17.7" text-anchor="middle">${week ? 7 : 1}</text></svg>`;
  }
  function periodButton(settings) {
    const week = isWeek(settings);
    const t = esc(tr(week ? 'w.period.week' : 'w.period.today'));
    return `<button class="ib period${week ? ' on' : ''}" data-act="period" title="${t}" aria-label="${t}" aria-pressed="${week}">${periodIcon(week)}</button>`;
  }

  function shownProviders(usage, settings) {
    return (usage.providers || []).filter((p) => {
      const cfg = (settings.providers || {})[p.id] || {};
      return p.enabled && cfg.visible !== false && p.detected;
    });
  }

  // ------------------------------------------------------------------ taskbar (docked)
  function taskbar(ctx) {
    const { usage, settings, system, now } = ctx;
    const o = settings.taskbar;
    const h = ctx.taskbarHeight || 40;
    const rowsMax = h >= 34 ? 2 : 1;
    const blocks = [];
    for (const p of shownProviders(usage, settings)) {
      const ws = U.visibleWindows(p, settings, o);
      const active = U.isActive(p, now) ? `<span class="live" title="${esc(tr('w.working'))}"></span>` : '';
      const bubble = meme(p, ws, now);
      let html = `<div class="prov" data-id="${p.id}" title="${esc(tooltip(p, settings, now))}">`;
      if (o.logo) html += `<span class="lg">${logo(p.id, h >= 34 ? 18 : 16)}${active}</span>`;
      if (o.name) html += `<span class="nm">${esc(p.name)}</span>`;
      if (bubble) html += bubble;
      if (!ws.length) {
        html += `<span class="tok">${U.fmtNum(statTokens(p, settings))}</span>`;
      }
      for (let i = 0; i < ws.length; i += rowsMax) {
        html += `<div class="grp" style="grid-template-rows:repeat(${Math.min(rowsMax, ws.length - i)},1fr)">`;
        for (const w of ws.slice(i, i + rowsMax)) {
          const sev = U.severity(w.usedPercent, settings.alertThresholds);
          html += `<div class="row">`;
          if (o.reset) html += `<span class="rs">${esc(resetText(w, settings, now, true))}</span>`;
          if (o.label) html += `<span class="lb">${esc(w.label)}</span>`;
          if (o.bar) html += meter(w, settings, { pace: o.pace });
          if (o.percent) html += `<span class="pc sev-${sev}">${U.fmtPct(U.shown(w, settings))}</span>`;
          if (o.forecast && w.exhaustBeforeReset) html += `<span class="fc" title="${esc(forecastText(w, now))}">▲</span>`;
          html += `</div>`;
        }
        html += `</div>`;
      }
      // Antigravity writes no token logs, so it has no token or cost figures
      if ((o.tokens || o.cost) && U.hasTokens(p.id)) {
        html += `<div class="ex">`;
        if (o.tokens) html += `<span>${U.fmtNum(statTokens(p, settings))}</span>`;
        if (o.cost) html += `<span>${U.fmtMoney(statCost(p, settings))}</span>`;
        html += `</div>`;
      }
      blocks.push(html + `</div>`);
    }
    if (o.system && system) {
      blocks.push(
        `<div class="prov sys" title="CPU ${Math.round(system.cpu)}% · RAM ${Math.round(system.ram)}%"><div class="grp" style="grid-template-rows:repeat(${rowsMax},1fr)">` +
          `<div class="row"><span class="lb">CPU</span>${sysMeter(system.cpu)}<span class="pc">${Math.round(system.cpu)}%</span></div>` +
          (rowsMax > 1 ? `<div class="row"><span class="lb">RAM</span>${sysMeter(system.ram)}<span class="pc">${Math.round(system.ram)}%</span></div>` : '') +
          `</div></div>`,
      );
    }
    if (!blocks.length) blocks.push(`<div class="prov empty">${esc(tr('w.noAgentsShort'))}</div>`);
    const gl = esc(tr('w.settings'));
    // the today ↔ 7 days switch sits by the gear when the strip shows any tokens or cost
    const showsTokens = o.tokens || o.cost || shownProviders(usage, settings).some((p) => !U.visibleWindows(p, settings, o).length);
    const per = showsTokens ? periodButton(settings) : '';
    const gear = o.gear !== false || per ? `<span class="sep"></span>${per}${o.gear !== false ? `<button class="ib gear" data-act="settings" title="${gl}" aria-label="${gl}">${ICON.gear}</button>` : ''}` : '';
    const free = ctx.docked === false ? ' free' : '';
    return `<div class="w taskbar${free}" style="--h:${h}px;--op:${settings.opacity}">${blocks.join('<span class="sep"></span>')}${gear}</div>`;
  }

  function sysMeter(v) {
    return `<div class="meter sys"><i style="width:${Math.min(100, v || 0)}%"></i></div>`;
  }

  /** How fresh the limits are: the oldest official-API reading among the shown agents. */
  function upd(list, usage, now) {
    const api = list.filter((p) => p.source === 'api' && p.limitsAt).map((p) => p.limitsAt);
    const at = api.length ? Math.min(...api) : usage.at;
    const stale = api.length && now - at > 10 * 60 * 1000;
    return `<span class="upd${stale ? ' stale' : ''}" title="${esc(tr('w.limitsAt'))}">${esc(U.relTime(at, now))}</span>`;
  }

  // ------------------------------------------------------------------ floating (card)
  function floating(ctx) {
    const { usage, settings, system, now } = ctx;
    const o = settings.floating;
    const list = shownProviders(usage, settings);
    advanceFx(list, settings, now);
    const chaos = moodFx.chaos ? chaosStage(moodFx.chaos, now) : null;
    // the bounce runs on the agent's block, so its stage delay rides on the section
    const fxDelay = (age) => `--fx-delay:-${Math.round(age)}ms`;
    let html = `<div class="w floating${chaos ? ` chaos-${chaos.stage}` : ''}" style="--op:${settings.opacity}">`;
    html += `<header class="head"><span class="mark"></span><span class="ttl">AgentMeter</span><span class="sp"></span>` +
      upd(list, usage, now) +
      `<button class="ib" data-act="refresh" title="${esc(tr('w.refresh'))}">${ICON.refresh}</button>` +
      periodButton(settings) +
      `<button class="ib" data-act="dashboard" title="${esc(tr('w.dashboard'))}">${ICON.panel}</button>` +
      (o.gear !== false ? `<button class="ib" data-act="settings" title="${esc(tr('w.settings'))}" aria-label="${esc(tr('w.settings'))}">${ICON.gear}</button>` : '') +
      `</header>`;
    for (const p of list) {
      const ws = U.visibleWindows(p, settings, o);
      const mine = chaos && moodFx.chaos.id === p.id ? chaos : null;
      const mood = !chaos && moodFx.mood && moodFx.mood.id === p.id ? moodFx.mood : null;
      const delay = mine ? fxDelay(mine.age) : mood ? fxDelay(now - mood.at) : '';
      html += `<section class="prov${mood ? ` mood ${mood.src}-${mood.kind}` : ''}" data-id="${p.id}"` +
        `${mine ? ` data-fx="${mine.stage}"` : ''}${delay ? ` style="${delay}"` : ''}>`;
      html += `<div class="ph">`;
      if (o.logo) html += logo(p.id, 18);
      if (o.name) html += `<span class="nm">${esc(p.name)}</span>`;
      if (mood) html += `<span class="mo" aria-hidden="true" style="animation-delay:-${Math.round(now - mood.at)}ms">${mood.emoji}</span>`;
      if (p.plan) html += `<span class="plan">${esc(p.plan)}</span>`;
      html += `<span class="sp"></span>`;
      if (U.isActive(p, now)) html += `<span class="state live-t"><i class="live"></i>${esc(tr('w.working'))}</span>`;
      html += `</div>`;
      // during an encounter the 5% bubble keeps quiet: one quip, at the end
      const bubble = mine
        ? mine.stage === 'line'
          ? `<span class="meme quip chaos" style="animation-delay:-${Math.round(mine.age)}ms">${esc(tr('w.chaos.line'))}</span>`
          : ''
        : meme(p, ws, now);
      if (bubble) html += `<div class="mrow">${bubble}</div>`;
      if (mood) html += `<div class="mrow"><span class="meme quip mood ${mood.src}" style="animation-delay:-${Math.round(now - mood.at)}ms">${esc(tr(mood.line))}</span></div>`;
      for (const w of ws) {
        const sev = U.severity(w.usedPercent, settings.alertThresholds);
        const val = U.shown(w, settings);
        html += `<div class="wl">`;
        if (o.label) html += `<span class="lb" title="${esc(U.windowName(w))}">${esc(w.label)}</span>`;
        if (o.bar) html += meter(w, settings, { pace: o.pace });
        if (o.percent) html += `<span class="pc sev-${sev}">${U.fmtPct(val)}${settings.valueMode === 'remaining' ? `<small>${esc(tr('w.left'))}</small>` : ''}</span>`;
        html += `</div>`;
        const meta = [];
        if (o.reset) {
          const r = resetText(w, settings, now, false);
          if (r) meta.push(`<span>${esc(r)}</span>`);
        }
        if (o.forecast) {
          const fc = forecastText(w, now);
          if (fc) meta.push(`<span class="fc">▲ ${esc(fc)}</span>`);
        }
        if (meta.length) html += `<div class="meta">${meta.join('')}</div>`;
      }
      if (!ws.length) html += `<div class="meta"><span>${esc(tr(p.id === 'qwen' ? 'w.localOnly' : 'w.noLimits'))}</span></div>`;
      const stats = [];
      const counted = U.hasTokens(p.id);
      const week = isWeek(settings);
      if (o.tokens && counted) stats.push(tr(week ? 'w.week' : 'w.today', { n: U.fmtNum(statTokens(p, settings)) }));
      if (o.cost && counted) stats.push(`<b>${U.fmtMoney(statCost(p, settings))}</b> <span title="${esc(tr('w.costTitle'))}">${esc(tr('w.cost'))}</span>`);
      if (stats.length) html += `<div class="st">${stats.join('<i></i>')}</div>`;
      html += `</section>`;
    }
    if (!list.length) html += `<section class="prov empty">${tr('w.noAgents')}</section>`;
    if (o.system && system) {
      html += `<footer class="sysf"><span>CPU</span>${sysMeter(system.cpu)}<b>${Math.round(system.cpu)}%</b><span>RAM</span>${sysMeter(system.ram)}<b>${Math.round(system.ram)}%</b></footer>`;
    }
    return html + `</div>`;
  }

  const ICON = {
    refresh: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"/></svg>',
    panel: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>',
    gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  };

  function widget(ctx) {
    ctx.now = ctx.now || Date.now();
    return ctx.mode === 'floating' ? floating(ctx) : taskbar(ctx);
  }

  root.AM_RENDER = {
    periodIcon,
    statTokens,
    statCost,
    widget,
    takeMemeEvents,
    MEME_MS,
    logo,
    meter,
    tooltip,
    resetText,
    forecastText,
    shownProviders,
    ICON,
    poke,
    previewChaos,
    previewMood,
    previewPoke,
    previewEncounter,
    chaosNext,
    fxNext,
    POKES,
    ENCOUNTERS,
    MOOD_MS,
    CHAOS_MS: { fit: CHAOS_FIT, still: CHAOS_STILL, line: CHAOS_LINE },
  };
})(typeof self !== 'undefined' ? self : this);
