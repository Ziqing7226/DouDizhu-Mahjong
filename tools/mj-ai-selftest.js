#!/usr/bin/env node
/* 斗地主&麻将 —— 纯前端单机游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/* ==========================================================================
 * mj-ai-selftest.js —— 麻将三档 AI 难度对局自测
 *
 * 用与 tests/test-ui.js 相同的 DOM 桩 + 虚拟时钟，把真实游戏代码完整跑起来，
 * 对 easy / hard / master 三档各打 N 局（默认 40），统计：
 *   - 我方胜率 / 三家 AI 总胜率 / 荒庄率 / 平均调度步数
 *   - 结算面板与牌桌 innerHTML 是否出现 "undefined"（回归扫描）
 *
 * 公平性设计：三家 AI 的强度随难度变化，因此我方（seat 0）用
 * 「固定 hard 档 AI 代打」策略（MjAI.decideDiscard + difficulty:'hard'，
 * 浮层只胡不过碰吃），保证三组对照里我方强度恒定，胜率差异全部来自对手。
 *
 * 运行：node tools/mj-ai-selftest.js [每难度局数，默认 40]
 * ==========================================================================
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const N_GAMES = parseInt(process.argv[2], 10) || 40;
const MAX_STEPS = 20000;

const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const JS_FILES = ['cards.js', 'decompose.js', 'ai.js', 'audio.js', 'music.js', 'voice.js',
  'storage.js', 'mobile.js', 'ui.js', 'game.js',
  'mj/tiles.js', 'mj/rules.js', 'mj/ai.js', 'mj/ui.js', 'mj/game.js', 'app.js'];

const sources = {};
for (const f of JS_FILES) sources[f] = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');

/* ============================================================
 * DOM 桩（与 tests/test-ui.js 同一套实现，裁剪掉计数部分）
 * ============================================================ */

const registry = {};   // id -> El

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
    if (k === 'id') { this.id = String(v); registry[this.id] = this; }
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

/* ---- 选择器：tag / #id / .class / [attr="v"] 组合与后代 ---- */

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

/* ---- 极简 HTML 解析 ---- */

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

/* ---- document / window 桩 ---- */

const body = new El('body');
parseInto(body, (HTML.match(/<body>([\s\S]*)<\/body>/) || [, ''])[1]);

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
  if (t.interval) t.at = vnow + t.interval, timers.push(t);
  t.fn();
  return true;
}

/* ---- vm 上下文 ---- */

const ctx = {
  console: { log() { }, error() { }, warn() { } },
  document: documentStub,
  performance: { now: () => vnow },
  requestAnimationFrame: () => 1,
  cancelAnimationFrame() { },
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
  Math, Date, JSON, Set, Map, Array, Object, String, Number, Boolean, Error,
  parseInt, parseFloat, isNaN, isFinite, RegExp, Symbol, Promise
};
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.self = ctx;
vm.createContext(ctx);

for (const f of JS_FILES) vm.runInContext(sources[f], ctx, { filename: f });

/* ---- MIX 模式：同桌混搭难度（seat 1/3 = hard，seat 2 = master）----
 * 直接对抗测量强度差：若大师升级有效，2 号位胜场份额应显著超过 1/3。
 * 包装 MjAI 决策入口，hard 座位剥离完全信息字段并降级 difficulty。 */
const MIX = process.env.MIX === '1';
if (MIX) {
  const A = ctx.MjAI;
  const seatIsHard = (c) => c && (c.seat === 1 || c.seat === 3);
  const hardify = (c) => {
    // 只保留 hard 档可见/可用的字段：剥离 hands / meldCounts / wallUnseen
    const o = { difficulty: 'hard' };
    ['seat', 'counts', 'meldBudget', 'unseen', 'opponentRivers', 'opponentTenpaiish',
      'wallLeft', 'pengMelds'].forEach(k => { if (c[k] !== undefined) o[k] = c[k]; });
    return o;
  };
  const orig = {
    decideDiscard: A.decideDiscard,
    hintCandidates: A.hintCandidates,
    shouldClaimSet: A.shouldClaimSet,
    selfCheck: A.selfCheck,
    shouldKong: A.shouldKong
  };
  A.decideDiscard = function (ctx) { return seatIsHard(ctx) ? orig.decideDiscard(hardify(ctx)) : orig.decideDiscard(ctx); };
  A.hintCandidates = function (ctx) { return seatIsHard(ctx) ? orig.hintCandidates(hardify(ctx)) : orig.hintCandidates(ctx); };
  A.shouldClaimSet = function (ctx, tile, kind, run) {
    return seatIsHard(ctx) ? orig.shouldClaimSet(hardify(ctx), tile, kind, run) : orig.shouldClaimSet(ctx, tile, kind, run);
  };
  A.selfCheck = function (ctx) { return seatIsHard(ctx) ? orig.selfCheck(hardify(ctx)) : orig.selfCheck(ctx); };
  A.shouldKong = function (ctx) {
    if (seatIsHard(ctx)) return true;                    // hard 档：无脑杠
    return !((ctx.wallLeft | 0) <= 4);                   // master 档：岭上不足 4 张不杠
  };
}

/* ---- 交互辅助 ---- */

function click(el) {
  if (!el) return false;
  const h = el._h && el._h.click;
  if (!h) return false;
  h({ target: el, preventDefault() { }, stopPropagation() { } });
  return true;
}

/* ============================================================
 * 我方固定策略（hard 档 AI 代打，保证三组对照公平）
 * ============================================================ */

const G = ctx.MjGame.G;

/** 复刻 game.js 的 aiCtx，但 difficulty 恒为 'hard'、视角恒为 seat 0 */
function seat0Ctx() {
  const my = G.players[0];
  const rivers = [];
  for (let i = 1; i < 4; i++) rivers.push(G.players[i].river.map(t => t.idx));

  const unseen = new Array(34).fill(4);
  my.hand.forEach(t => { unseen[t.idx]--; });
  G.players.forEach(p => {
    p.river.forEach(t => { unseen[t.idx]--; });
    p.melds.forEach(m => {
      if (m.type !== 'angang' || p.seat === 0) m.tiles.forEach(i => { unseen[i]--; });
    });
  });

  // 听牌估计与 game.js 非 master 分支一致：副露折算后 ≤13 张且手牌 ≤5 张
  let tenpaiish = false;
  for (let i = 1; i < 4; i++) {
    const p = G.players[i];
    if (p.hand.length + p.melds.length * 3 <= 13 && p.hand.length <= 5) { tenpaiish = true; break; }
  }

  return {
    difficulty: 'hard',
    seat: 0,
    counts: ctx.MjTiles.countsOf(my.hand),
    meldBudget: 4 - my.melds.length,
    unseen,
    opponentRivers: rivers,
    opponentTenpaiish: tenpaiish,
    wallLeft: G.wall.length
  };
}

function floatButtons() {
  const layer = registry.floatLayer;
  if (!layer || !layer.children.length) return [];
  return layer.children[0].querySelectorAll('.btn').filter(b => !b.disabled);
}

/** 驱动一局到终局。返回调度步数；负值 = 异常终止 */
function playGame() {
  let steps = 0;
  while (steps++ < MAX_STEPS) {
    if (G.phase === 'over') return steps;

    // 浮层（荣和/杠/碰/吃询问）：有胡点胡；杠无脑点；碰/吃用固定 hard 档
    // shouldClaimSet 评估（真实玩家的中等水平基线，对难度差异敏感）
    const btns = floatButtons();
    if (btns.length) {
      const hu = btns.find(b => b.textContent === '胡');
      if (hu) { click(hu); continue; }
      const gang = btns.find(b => b.textContent.indexOf('杠') === 0);
      if (gang) { click(gang); continue; }
      const claim = btns.find(b => b.textContent.indexOf('碰') === 0 || b.textContent.indexOf('吃') === 0);
      if (claim && G.lastDiscard) {
        const kind = claim.textContent.indexOf('碰') === 0 ? 'peng' : 'chi';
        const tile = G.lastDiscard.tile;
        const my = G.players[0];
        const unseen = (() => {
          const u = new Array(34).fill(4);
          my.hand.forEach(t => { u[t.idx]--; });
          G.players.forEach(p => {
            p.river.forEach(t => { u[t.idx]--; });
            p.melds.forEach(m => {
              if (m.type !== 'angang' || p.seat === 0) m.tiles.forEach(i => { u[i]--; });
            });
          });
          return u;
        })();
        let run = null;
        if (kind === 'chi') {
          // 从按钮文本解析吃的搭子（shortOf 为数字+花色，如 1万2万3万），补上被吃那张
          const Tiles = ctx.MjTiles;
          const nums = claim.textContent.replace(/^吃/, '').match(/([1-9])(万|条|筒)|([东南西北中發发白])/g) || [];
          const idxs = nums.map(n => {
            for (let i = 0; i < 34; i++) if (Tiles.shortOf(i) === n) return i;
            return -1;
          }).filter(i => i >= 0);
          run = idxs.indexOf(tile.idx) >= 0 && idxs.length === 3
            ? idxs.slice().sort((a, b) => a - b)
            : (idxs.length === 2 ? idxs.concat([tile.idx]).sort((a, b) => a - b) : null);
        }
        if (kind === 'chi' && !run) {
          const passBtn = btns.find(b => b.textContent === '过');
          if (passBtn) click(passBtn);
          continue;
        }
        const yes = ctx.MjAI.shouldClaimSet({
          difficulty: 'hard',
          counts: ctx.MjTiles.countsOf(my.hand),
          meldBudget: 4 - my.melds.length,
          unseen,
          opponentTenpaiish: false
        }, tile.idx, kind, run);
        if (yes) { click(claim); continue; }
      }
      const guo = btns.find(b => b.textContent === '过');
      if (guo) { click(guo); continue; }
    }

    // 我方回合：固定 hard 档 AI 选张（pendingTurn 窗口内不操作，等价真实 UI 禁用态）
    const my = G.players[0];
    if (G.phase === 'playing' && G.turn === 0 && !G.busy && !G.pendingTurn && my.hand.length % 3 === 2) {
      let idx = ctx.MjAI.decideDiscard(seat0Ctx());
      if (idx === null || idx === undefined) idx = my.hand[my.hand.length - 1].idx;
      // 桩环境的 dataset 不做字符串化，统一 String 后比较（真实 DOM 同样是字符串）
      const el = registry.mjHand.children.find(ch => ch.dataset && String(ch.dataset.idx) === String(idx));
      if (el && click(el)) {
        const disc = registry.mjBtnDiscard;
        if (!disc.disabled) { click(disc); continue; }
      }
    }

    if (!flushOne()) return -2;   // 时钟空转且无事可做 → 卡死
  }
  return -1;
}

/** 开新局；如触发健康休息闸门则点掉提醒（onClick 会重新执行 newGame） */
function newGameSafe() {
  ctx.MjGame.newGame();
  const d = registry.dialog;
  if (d && d.classList.contains('show')) {
    const btn = d.querySelectorAll('.btn').find(b => b.textContent.indexOf('休息完毕') >= 0);
    if (btn) click(btn);
  }
}

/** 全树扫描 "undefined" 字样（荒庄复盘 undefined 回归扫描） */
function undefinedSeen() {
  const all = descendants(body);
  for (const el of all) {
    if ((el._html && el._html.indexOf('undefined') >= 0) ||
        (el._text && el._text.indexOf('undefined') >= 0)) return true;
  }
  return false;
}

/* ============================================================
 * 三难度自测
 * ============================================================ */

function pickRoom(diff) {
  const btn = registry.mjLobby.querySelectorAll('button').find(b => b.dataset.d === diff);
  if (!btn) throw new Error('麻将大厅缺少难度按钮: ' + diff);
  click(btn);
}

const DIFFS = (process.env.DIFFS || 'easy,hard,master').split(',');
const report = {};

/* ---- MIX 专属运行路径：同桌 1/3 hard vs 2 master ---- */
if (MIX) {
  ctx.MjGame.enterLobby();
  pickRoom('master');   // G.difficulty = master：2 号位获得完全信息决策
  let timeout = 0, meldCap = 0, done = 0;
  const seatWins = { 0: 0, 1: 0, 2: 0, 3: 0 };
  const seatDelta = { 0: 0, 1: 0, 2: 0, 3: 0 };

  for (let g = 0; g < N_GAMES; g++) {
    const steps = playGame();
    if (steps < 0 || G.phase !== 'over') { timeout++; break; }
    done++;
    if (G.players.some(p => p.melds.length > 4)) meldCap++;
    G.players.forEach(p => {
      if ((p.delta || 0) > 0) seatWins[p.seat]++;
      seatDelta[p.seat] += (p.delta || 0);
    });
    timers = [];
    if (g < N_GAMES - 1) newGameSafe();
  }

  console.log(`MIX 模式：seat1/3 = hard，seat2 = master，共 ${done} 局（seat0 固定代打不参与胜负比较）`);
  const hardW = seatWins[1] + seatWins[3];
  const fair = (done - seatWins[0]) / 3;
  console.log(`  胜场: hard合记 ${hardW}（东 ${seatWins[1]} / 西 ${seatWins[3]}）  master ${seatWins[2]}  座位0 ${seatWins[0]}  荒庄外局数 ${done}`);
  console.log(`  每座位公平份额基准 ≈ ${fair.toFixed(1)} 胜；master 超出份额 ${(seatWins[2] - fair).toFixed(1)} 胜（+${done ? ((seatWins[2] / fair) * 100 - 100).toFixed(1) : 0}%）`);
  console.log(`  累计番分: hard合记 ${seatDelta[1] + seatDelta[3]}  master ${seatDelta[2]}  座位0 ${seatDelta[0]}`);
  if (timeout) { console.log('✗ 存在未跑到终局的对局'); process.exit(1); }
  if (meldCap) { console.log('✗ 存在副露超过 4 组的对局'); process.exit(1); }
  const lead = seatWins[2] - fair;
  if (lead > 0 && seatWins[2] > seatWins[1] && seatWins[2] > seatWins[3]) {
    console.log('\n✓ 大师升级有效：master 座位胜场份额显著领先 hard 座位');
  } else {
    console.log('\n✗ master 座位未领先 hard 座位，升级强度不足或未生效');
    process.exit(1);
  }
  process.exit(0);
}

console.log(`麻将 AI 三难度对局自测：我方固定 hard 档代打，每难度 ${N_GAMES} 局`);
console.log('='.repeat(64));

for (const diff of DIFFS) {
  ctx.MjGame.enterLobby();
  pickRoom(diff);
  if (G.phase !== 'playing') throw new Error(diff + ' 选场后未进入对局');
  if (G.difficulty !== diff) throw new Error('G.difficulty 应为 ' + diff + '，实际 ' + G.difficulty);

  let wins = 0, draws = 0, timeout = 0, undef = 0, meldCap = 0;
  let seat0Delta = 0, stepsSum = 0, done = 0;
  const aiWinSeats = { 1: 0, 2: 0, 3: 0 };

  for (let g = 0; g < N_GAMES; g++) {
    const steps = playGame();
    if (steps < 0 || G.phase !== 'over') { timeout++; break; }
    done++;
    if (G.players.some(p => p.melds.length > 4)) meldCap++;

    const deltas = G.players.map(p => p.delta || 0);
    const winners = [];
    deltas.forEach((d, i) => { if (d > 0) winners.push(i); });

    if (winners.length === 0) draws++;
    else {
      if (winners.includes(0)) wins++;
      winners.forEach(s => { if (s > 0) aiWinSeats[s]++; });
    }
    seat0Delta += deltas[0];
    stepsSum += steps;
    if (undefinedSeen()) undef++;

    timers = [];   // 清掉上一局遗留的动画定时器（必须先清再开局，避免误删新局调度）
    if (g < N_GAMES - 1) newGameSafe();
  }

  const r = report[diff] = {
    done, wins, draws, timeout, undef, meldCap,
    winRate: done ? wins / done : 0,
    drawRate: done ? draws / done : 0,
    aiWinRate: done ? (done - wins - draws) / done : 0,
    avgSteps: done ? Math.round(stepsSum / done) : 0,
    seat0Delta, aiWinSeats
  };

  console.log(`\n【${diff}】完成 ${done}/${N_GAMES} 局` + (timeout ? `（${timeout} 局异常终止）` : ''));
  console.log(`  我方胜率 ${(r.winRate * 100).toFixed(1)}%（${wins} 胜）  AI 总胜率 ${(r.aiWinRate * 100).toFixed(1)}%  荒庄率 ${(r.drawRate * 100).toFixed(1)}%`);
  console.log(`  我方累计番分 ${seat0Delta > 0 ? '+' : ''}${seat0Delta}  平均每局 ${r.avgSteps} 次调度`);
  console.log(`  AI 各家胜场: 东(${aiWinSeats[1]}) 南(${aiWinSeats[2]}) 西(${aiWinSeats[3]})  undefined 出现 ${undef} 次  副露超4组 ${meldCap} 局`);
}

console.log('\n' + '='.repeat(64));
console.log('难度梯度检验：');
console.log('  我方胜率  ' + DIFFS.map(d => `${d} ${(report[d].winRate * 100).toFixed(1)}%`).join('  /  '));
const wr = DIFFS.map(d => report[d].winRate);
let graded = true;
for (let i = 1; i < wr.length; i++) if (wr[i - 1] < wr[i] - 1e-9) graded = false;
console.log(graded
  ? '  ✓ 梯度成立：对手越强，我方（固定 hard 代打）胜率不升'
  : '  ✗ 梯度不成立，需检查难度配置');
console.log('  荒庄率    ' + DIFFS.map(d => `${d} ${(report[d].drawRate * 100).toFixed(1)}%`).join('  /  '));

if (DIFFS.some(d => report[d].undef > 0)) {
  console.log('\n✗ 发现 "undefined" 文案泄漏，需排查');
  process.exit(1);
}
if (DIFFS.some(d => report[d].meldCap > 0)) {
  console.log('\n✗ 存在副露超过 4 组的对局（上限守卫失效）');
  process.exit(1);
}
if (DIFFS.some(d => report[d].timeout > 0)) {
  console.log('\n✗ 存在未跑到终局的对局');
  process.exit(1);
}
console.log('\n自测通过 ✓');
