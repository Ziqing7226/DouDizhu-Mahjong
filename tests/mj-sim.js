/* 斗地主&麻将 · 棋牌合集 —— 纯前端单机游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * mj-sim.js —— 麻将 AI 行为测量（点炮率 / 抢杠 / 强度）
 *
 * 与 test-ui.js 的分工：test-ui 用「一局冒烟」验证结构正确性；
 * 本工具把同一套无头环境（DOM 桩 + 虚拟时钟）连跑几百上千局，
 * 驱动的是真实的 mj/game.js 全流程（鸣牌优先级、岭上补牌、抢杠、
 * 荒庄、结算翻倍全部走线上代码），逐局从结算面板提取结果。
 *
 * 口径：
 *   0 号位 = 固定策略代打（永远打最后一张，争抢一律「过」，自摸/接炮自动胡）；
 *   1-3 号位 = 房间难度 AI；点炮率按 AI 三家合计（每局限 0~3 次）；
 *   抢杠 = 结算面板「抢 X 的杠」；接炮 = 「接 X 的炮」；自摸 = 三家分摊。
 *
 * 用法：
 *   node tests/mj-sim.js [局数=300] [种子=20260906]
 *   MJ_DIFF=hard            换房间难度（默认 master）
 *   MJ_TUNE=foldProb:0.5    对局前覆盖 MjAI.TUNE 旋钮（键名见 js/mj/ai.js）
 *   MJ_HOOK=tests/mj-hook-deadly.js  注入调试钩子（决策/点炮现场探查）
 * ========================================================================== */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const JS_FILES = ['cards.js', 'decompose.js', 'ai.js', 'audio.js', 'music.js', 'voice.js',
  'storage.js', 'mobile.js', 'ui.js', 'game.js',
  'mj/tiles.js', 'mj/rules.js', 'mj/ai.js', 'mj/ui.js', 'mj/game.js', 'app.js'];

const N = Number(process.argv[2] || 300);
const SEED = Number(process.argv[3] || 20260906);
const DIFF = process.env.MJ_DIFF || 'master';
const TUNE_ENV = process.env.MJ_TUNE || '';

/* ---- 种子化 Math.random：整场运行可复现（洗牌 / 庄家 / 新手随机全走它） ---- */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const stream = mulberry32(SEED);
const SMath = Object.create(Math);
SMath.random = function () { return stream(); };

/* ============================================================
 * 极简 DOM 桩（与 test-ui.js 同款，只保留本工具用到的部分）
 * ============================================================ */

const registry = {};

class El {
  constructor(tag) {
    this.tagName = String(tag).toLowerCase();
    this.children = [];
    this.parentNode = null;
    this._id = '';
    this.className = '';
    this.attrs = {};
    this.dataset = {};
    this._text = '';
    this._html = '';
    this._h = {};
    this._disabled = false;
    this.style = {
      setProperty() { }, removeProperty() { },
      getPropertyValue() { return ''; }
    };
    const self = this;
    this.classList = {
      add(c) { const s = new Set(self.className.split(/\s+/).filter(Boolean)); s.add(c); self.className = [...s].join(' '); },
      remove(c) { const s = new Set(self.className.split(/\s+/).filter(Boolean)); s.delete(c); self.className = [...s].join(' '); },
      contains(c) { return self.className.split(/\s+/).includes(c); },
      toggle(c, f) {
        if (f === undefined) f = !this.contains(c);
        f ? this.add(c) : this.remove(c);
        return f;
      }
    };
  }
  get id() { return this._id; }
  set id(v) { this._id = String(v); registry[this._id] = this; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === 'id') this.id = String(v);
    if (k.startsWith('data-')) this.dataset[k.slice(5)] = String(v);
  }
  getAttribute(k) { return this.attrs[k]; }
  set textContent(v) { this._text = String(v); this.children = []; this._html = String(v); }
  get textContent() { return this._text; }
  set innerHTML(v) { this._html = String(v); this.children = []; parseInto(this, String(v)); }
  get innerHTML() { return this._html; }
  addEventListener(ev, fn) { this._h[ev] = fn; }
  removeEventListener(ev) { delete this._h[ev]; }
  querySelector(sel) { return queryAll(this, sel)[0] || null; }
  querySelectorAll(sel) { return queryAll(this, sel); }
  closest(sel) {
    let n = this;
    while (n) { if (matches(n, parseSimple(sel))) return n; n = n.parentNode; }
    return null;
  }
  get firstChild() { return this.children[0] || null; }
  get disabled() { return !!this._disabled; }
  set disabled(v) { this._disabled = !!v; }
}

function parseSimple(sel) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  let s = sel.trim();
  const m = s.match(/^([a-zA-Z][\w-]*)/);
  if (m) { out.tag = m[1].toLowerCase(); s = s.slice(m[1].length); }
  const re = /([.#][\w-]+|\[[^\]]+\])/g;
  let t;
  while ((t = re.exec(s))) {
    const tok = t[1];
    if (tok[0] === '#') out.id = tok.slice(1);
    else if (tok[0] === '.') out.classes.push(tok.slice(1));
    else {
      const am = tok.slice(1, -1).match(/^([\w-]+)\s*=\s*["']?([^"']*)["']?$/);
      if (am) out.attrs.push([am[1], am[2]]);
    }
  }
  return out;
}

function matches(el, s) {
  if (!el || !el.tagName) return false;
  if (s.tag && el.tagName !== s.tag) return false;
  if (s.id && el.id !== s.id) return false;
  const cls = el.className.split(/\s+/);
  for (const c of s.classes) if (!cls.includes(c)) return false;
  for (const [k, v] of s.attrs) {
    let actual;
    if (k.startsWith('data-')) actual = el.dataset[k.slice(5)];
    else if (k === 'id') actual = el.id;
    else if (k === 'class') actual = el.className;
    else actual = el.attrs[k];
    if (actual === undefined || actual === null) return false;
    if (v !== null && String(actual) !== v) return false;
  }
  return true;
}

function descendants(el, out) {
  out = out || [];
  for (const c of el.children) { out.push(c); descendants(c, out); }
  return out;
}

function queryAll(root, sel) {
  const parts = sel.trim().split(/\s+(?![^\[]*\])/).map(parseSimple);
  let cur = [root];
  for (const p of parts) {
    const next = [];
    for (const node of cur) {
      for (const d of descendants(node)) {
        if (matches(d, p) && !next.includes(d)) next.push(d);
      }
    }
    cur = next;
  }
  return cur;
}

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);

function parseInto(parent, html) {
  const stack = [parent];
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^>]*?)?)(\/?)>/g;
  let m;
  let skipTag = null;
  while ((m = re.exec(html))) {
    const [, close, rawTag, attrs, selfClose] = m;
    const tag = rawTag.toLowerCase();
    if (skipTag) { if (close && tag === skipTag) skipTag = null; continue; }
    if (tag === 'script' || tag === 'style') { if (!close) skipTag = tag; continue; }
    if (close) { if (stack.length > 1) stack.pop(); continue; }
    const el = new El(tag);
    const ar = /([\w:-]+)\s*=\s*"([^"]*)"/g;
    let a;
    while ((a = ar.exec(attrs))) {
      const k = a[1], v = a[2];
      el.attrs[k] = v;
      if (k === 'id') { el.id = v; registry[v] = el; }
      else if (k === 'class') el.className = v;
      else if (k.startsWith('data-')) el.dataset[k.slice(5)] = v;
    }
    stack[stack.length - 1].appendChild(el);
    if (!selfClose && !VOID_TAGS.has(tag)) stack.push(el);
  }
  return parent;
}

const bodyHtml = (HTML.match(/<body>([\s\S]*)<\/body>/) || [, ''])[1];
const body = new El('body');
parseInto(body, bodyHtml);

const documentStub = {
  body,
  readyState: 'complete',
  getElementById(id) {
    const el = registry[id];
    if (!el) return null;
    let n = el;
    while (n.parentNode) n = n.parentNode;
    return n === body ? el : null;
  },
  createElement(tag) { return new El(tag); },
  querySelector(sel) { return queryAll(body, sel)[0] || null; },
  querySelectorAll(sel) { return queryAll(body, sel); },
  elementFromPoint() { return null; },
  addEventListener(ev, fn) { (this._h = this._h || {})[ev] = fn; },
  removeEventListener() { }
};

/* ---- 虚拟时钟 ---- */

let vnow = 0;
let tid = 1;
let timers = [];

function vSetTimeout(fn, ms) {
  const t = { id: tid++, at: vnow + (Number(ms) || 0), fn, interval: 0 };
  timers.push(t);
  return t.id;
}
function vSetInterval(fn, ms) {
  const t = { id: tid++, at: vnow + (Number(ms) || 0), fn, interval: Math.max(1, Number(ms) || 1) };
  timers.push(t);
  return t.id;
}
function vClear(id) { timers = timers.filter(t => t.id !== id); }

function flushOne() {
  if (!timers.length) return false;
  timers.sort((a, b) => (a.at - b.at) || (a.id - b.id));
  const t = timers.shift();
  if (t.at > vnow) vnow = t.at;
  if (t.interval) { t.at = vnow + t.interval; timers.push(t); }
  t.fn();
  return true;
}

/* ---- 上下文 ---- */

const ctx = {
  console,
  document: documentStub,
  performance: { now: () => vnow },
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => { },
  addEventListener(ev, fn) { (this._winH = this._winH || {})[ev] = fn; },
  removeEventListener(ev) { delete (this._winH || {})[ev]; },
  innerWidth: 1280,
  innerHeight: 800,
  setTimeout: vSetTimeout,
  clearTimeout: vClear,
  setInterval: vSetInterval,
  clearInterval: vClear,
  localStorage: {
    _d: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
  },
  Math: SMath, Date, JSON, Set, Map, Array, Object, String, Number, Boolean, Error,
  parseInt, parseFloat, isNaN, isFinite, RegExp, Symbol, Promise
};
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.self = ctx;
vm.createContext(ctx);

for (const f of JS_FILES) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), ctx, { filename: f });
}

const G2 = ctx.MjGame.G;
const MjAI = ctx.MjAI;

/* ---- TUNE 注入（必须在开局前）。注意：vm 沙箱对象的 in 运算跨边界会
 * 失灵（has=false），必须用 hasOwnProperty 判断键存在 ---- */
/* ---- TUNE 注入（必须在开局前），键名用 MjAI.TUNE 的真实键 ---- */
if (TUNE_ENV) {
  TUNE_ENV.split(',').forEach(function (kv) {
    const p = kv.split(':');
    if (p.length === 2 && p[0] in MjAI.TUNE) MjAI.TUNE[p[0]] = Number(p[1]);
  });
}

function click(el) {
  if (!el) return false;
  const h = el._h && el._h.click;
  if (!h) return false;
  h({ target: el, preventDefault() { }, stopPropagation() { } });
  return true;
}

/* ---- 可选调试钩子：MJ_HOOK=文件路径，内容作为 JS 注入沙箱（在开局前执行） ---- */
if (process.env.MJ_HOOK) {
  vm.runInContext(fs.readFileSync(process.env.MJ_HOOK, 'utf8'), ctx, { filename: 'mj-hook' });
}

/* ---- 进入选定场次 ---- */
click(registry.btnGameMode);
const mjModeBtn = [...documentStub.querySelectorAll('button')].find(b => b.dataset.game === 'mj');
click(mjModeBtn);
const mjRoom = [...registry.mjLobby.querySelectorAll('button')].find(b => b.dataset.d === DIFF);
if (!mjRoom) { console.error('找不到场次按钮: ' + DIFF); process.exit(1); }
click(mjRoom);
if (G2.phase !== 'playing') { console.error('选场后未进入对局'); process.exit(1); }

const seatOf = {};
function buildSeatMap() {
  G2.players.forEach(p => { seatOf[p.name] = p.seat; });
}
buildSeatMap();

/* ---- 逐局驱动：0 号位打最后一张，争抢一律过；终局后点「再来一局」 ---- */

function driveRound() {
  let steps = 0;
  while (steps++ < 60000) {
    if (G2.phase === 'over') return harvest();
    const my = G2.players[0];
    if (G2.phase === 'playing' && G2.turn === 0 && !G2.busy && !G2.pendingTurn &&
      my.hand.length % 3 === 2) {
      const hand = registry.mjHand;
      const n = hand.children.length;
      if (n > 0 && hand.children[n - 1]._h && hand.children[n - 1]._h.click) {
        hand.children[n - 1]._h.click({});
        const disc = registry.mjBtnDiscard;
        if (!disc.disabled && disc._h && disc._h.click) { disc._h.click({}); continue; }
      }
    }
    const layer = registry.floatLayer;
    if (layer && layer.children.length) {
      const btns = layer.children[0].querySelectorAll('.btn').filter(b => !b.disabled);
      const guo = btns.find(b => b.textContent === '过');
      if (guo) { click(guo); continue; }
    }
    if (!flushOne()) return { stuck: true };
  }
  return { timeout: true };
}

function harvest() {
  const html = G2.settleHtml || '';
  const round = { draw: true, winner: -1, loser: -1, rob: false, fan: 0, selfDraw: false };
  const wm = html.match(/胡牌者<\/span><b>([^<]+)<\/b>/);
  if (!wm) return round;                       // 荒庄
  round.draw = false;
  round.winner = seatOf[wm[1]] !== undefined ? seatOf[wm[1]] : -1;
  round.fan = Number((html.match(/番数<\/span><b>(\d+) 番/) || [0, 0])[1]);
  const rob = html.match(/抢 (.+?) 的杠/);
  const deal = html.match(/接 (.+?) 的炮/);
  if (rob) { round.rob = true; round.loser = seatOf[rob[1]] !== undefined ? seatOf[rob[1]] : -1; }
  else if (deal) { round.loser = seatOf[deal[1]] !== undefined ? seatOf[deal[1]] : -1; }
  else round.selfDraw = true;
  return round;
}

function nextRound() {
  const dialog = registry.dialog;
  const again = dialog && [...dialog.querySelectorAll('.btn')].find(b => b.textContent === '再来一局');
  if (!again) return false;
  click(again);
  return true;
}

/* ---- 主循环与统计 ---- */

const perSeat = [];
for (let s = 0; s < 4; s++) {
  perSeat.push({ win: 0, selfWin: 0, dealIn: 0, robDealt: 0, tsumoShare: 0, delta: 0, dealInFan: 0 });
}
let draws = 0, robs = 0, timeouts = 0;
const t0 = Date.now();

for (let r = 1; r <= N; r++) {
  const round = driveRound();
  if (round.stuck || round.timeout) {
    timeouts++;
    console.error(`第 ${r} 局${round.stuck ? '卡死' : '超步'}，终止（已完成 ${r - 1} 局）`);
    break;
  }
  if (round.draw) { draws++; }
  else {
    if (round.winner >= 0) perSeat[round.winner].win++;
    if (round.selfDraw && round.winner >= 0) perSeat[round.winner].selfWin++;
    if (round.rob) robs++;
    if (round.loser >= 0) {
      perSeat[round.loser].dealIn++;
      perSeat[round.loser].dealInFan += round.fan;
    }
  }
  G2.players.forEach((p, s) => { perSeat[s].delta += p.delta; });
  if (r < N && !nextRound()) { console.error(`第 ${r} 局后找不到「再来一局」按钮`); break; }
}

const done = perSeat[0].win + perSeat[1].win + perSeat[2].win + perSeat[3].win + draws;
const aiDealIn = perSeat[1].dealIn + perSeat[2].dealIn + perSeat[3].dealIn;
const aiDelta = perSeat[1].delta + perSeat[2].delta + perSeat[3].delta;
const aiWin = perSeat[1].win + perSeat[2].win + perSeat[3].win;
const rounds = done - draws === 0 ? 1 : done;   // 有成绩的局数（含荒庄）

if (typeof ctx.__dbgHits === 'function') {
  console.log('DEBUGHITS ' + ctx.__dbgHits());
}
console.log('---- mj-sim 结果 ----');
console.log(`配置: 难度=${DIFF} TUNE=${JSON.stringify(MjAI.TUNE)} 局数=${done} 种子=${SEED} 用时=${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`胡牌局 ${done - draws}（荒庄 ${draws}，抢杠 ${robs}，异常 ${timeouts}）`);
console.log(`AI 三家合计: 点炮 ${aiDealIn} 次 = ${(aiDealIn / rounds).toFixed(3)} 次/局 | ` +
  `胡牌 ${aiWin} = ${(aiWin / rounds * 100).toFixed(1)}%/局 | 场均净分 ${(aiDelta / rounds).toFixed(1)}`);
for (let s = 0; s < 4; s++) {
  const st = perSeat[s];
  console.log(`  ${s}号位(${s === 0 ? '固定代打' : DIFF}): ` +
    `胡 ${st.win}(自摸${st.selfWin}) 点炮 ${st.dealIn} 抢杠 ${st.robDealt} ` +
    `净分 ${st.delta} 场均 ${(st.delta / rounds).toFixed(1)}`);
}
