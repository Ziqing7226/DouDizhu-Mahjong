/* 斗地主 —— 纯前端单机斗地主游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * test-ui.js —— 无浏览器端到端测试
 * 用极简 DOM 桩 + 虚拟时钟把 index.html 的整套脚本原样跑起来，
 * 覆盖：脚本语法、DOM id 引用、渲染层、叫分/加倍/出牌/结算全流程、对局不变量。
 *
 * 运行： node tests/test-ui.js
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

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; failures.push(msg); }
}

/* ============================================================
 * 1. 静态检查
 * ============================================================ */
console.log('=== 静态检查 ===');

const sources = {};
for (const f of JS_FILES) {
  const p = path.join(ROOT, 'js', f);
  sources[f] = fs.readFileSync(p, 'utf8');
  try {
    new vm.Script(sources[f], { filename: f });
    pass++;
  } catch (e) {
    fail++; failures.push(`语法错误 ${f}: ${e.message}`);
  }
}
console.log(`  ${JS_FILES.length} 个脚本语法检查完毕`);

// HTML 中引用的 id 是否齐全
const htmlIds = new Set([...HTML.matchAll(/id="([^"]+)"/g)].map(x => x[1]));
const allSrc = JS_FILES.map(f => sources[f]).join('\n');
const bindBlock = sources['ui.js'].match(/\[\s*'playArea'([\s\S]*?)\]\s*\.forEach/);
const usedIds = new Set(
  [...(bindBlock ? bindBlock[1].matchAll(/'([^']+)'/g) : [])].map(x => x[1])
    .concat(['box-0', 'box-1', 'box-2'])
);
const missingIds = [...usedIds].filter(i => !htmlIds.has(i));
ok(missingIds.length === 0, `HTML 缺少这些 id: ${missingIds.join(', ')}`);
console.log(`  引用 id ${usedIds.size} 个，缺失 ${missingIds.length} 个`);

// 标签配平（只看 body 内的容器标签）
const bodyHtml = (HTML.match(/<body>([\s\S]*)<\/body>/) || [, ''])[1];
for (const tag of ['div', 'button', 'aside', 'header', 'span']) {
  const open = (bodyHtml.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
  const close = (bodyHtml.match(new RegExp(`</${tag}>`, 'g')) || []).length;
  ok(open === close, `<${tag}> 标签不配平：开 ${open} 闭 ${close}`);
}

/* ============================================================
 * 2. 极简 DOM 桩
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

  // 真实 DOM 中给 element.id 赋值即可被 getElementById 找到，这里要等价
  get id() { return this._id; }
  set id(v) { this._id = String(v); registry[this._id] = this; }

  appendChild(c) {
    this.children.push(c);
    c.parentNode = this;
    return c;
  }
  removeChild(c) {
    this.children = this.children.filter(x => x !== c);
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === 'id') { this.id = String(v); registry[this.id] = this; }
    if (k.startsWith('data-')) this.dataset[k.slice(5)] = String(v);
  }
  getAttribute(k) { return this.attrs[k]; }

  set textContent(v) { this._text = String(v); this.children = []; this._html = String(v); }
  get textContent() { return this._text; }

  set innerHTML(v) {
    this._html = String(v);
    this.children = [];
    parseInto(this, String(v));
  }
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

/* ---- 选择器：支持 tag / #id / .class / [attr="v"] 的组合与后代 ---- */

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

/* ---- 极简 HTML 解析，用于构建 index.html 的真实树 & innerHTML ---- */

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);

function parseInto(parent, html) {
  const stack = [parent];
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^>]*?)?)(\/?)>/g;
  let m;
  let skipTag = null;
  while ((m = re.exec(html))) {
    const [full, close, rawTag, attrs, selfClose] = m;
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
parseInto(body, bodyHtml);

const documentStub = {
  body,
  readyState: 'complete',
  // 与真实 DOM 一致的两条语义：
  //   1) id 不存在 → 返回 null（绝不「顺手造一个」）
  //   2) 元素已被 remove() 移出文档树 → 同样返回 null
  // 否则 closeFloat() 会删掉幻影 / 找不到面板，制造出根本不存在的 bug。
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
  // 拖动连选用；测试里按需替换为具体卡牌
  elementFromPoint() { return null; },
  addEventListener(ev, fn) { (this._h = this._h || {})[ev] = fn; },
  removeEventListener() { }
};

/* ---- 虚拟时钟：所有 setTimeout / setInterval 都排在虚拟时间轴上 ---- */

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

/** 执行下一个到期任务，返回是否执行了 */
function flushOne() {
  if (!timers.length) return false;
  timers.sort((a, b) => (a.at - b.at) || (a.id - b.id));
  const t = timers.shift();
  if (t.at > vnow) vnow = t.at;
  if (t.interval) t.at = vnow + t.interval, timers.push(t);
  t.fn();
  return true;
}

/* ---- 统计渲染调用次数，确认渲染层真的执行了 ---- */
let domOps = 0;
const origAppend = El.prototype.appendChild;
El.prototype.appendChild = function (c) { domOps++; return origAppend.call(this, c); };
const origInner = Object.getOwnPropertyDescriptor(El.prototype, 'innerHTML');
Object.defineProperty(El.prototype, 'innerHTML', {
  get() { return origInner.get.call(this); },
  set(v) { domOps++; origInner.set.call(this, v); }
});

/* ---- 上下文 ---- */

const ctx = {
  console,
  document: documentStub,
  performance: { now: () => vnow },
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => { },
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
// 不提供 AudioContext —— audio.js 会自动降级为静默
vm.createContext(ctx);

/* ============================================================
 * 3. 加载脚本
 * ============================================================ */
console.log('\n=== 加载脚本 ===');

let loadErr = null;
try {
  for (const f of JS_FILES) {
    vm.runInContext(sources[f], ctx, { filename: f });
  }
} catch (e) {
  loadErr = e;
}
ok(!loadErr, '脚本加载异常: ' + (loadErr && loadErr.stack ? loadErr.stack.split('\n').slice(0, 4).join('\n') : ''));
if (loadErr) { report(); process.exit(1); }

console.log('  Cards / Decompose / AI / Sound / Store / UI / Game 全部挂载成功');
ok(!!ctx.Cards && !!ctx.Decompose && !!ctx.AI && !!ctx.UI && !!ctx.Game && !!ctx.Sound && !!ctx.Store,
  '全局模块未全部挂载');

const G = ctx.Game.G;

/* ============================================================
 * 4. 交互辅助
 * ============================================================ */

function click(el) {
  if (!el) return false;
  const h = el._h && el._h.click;
  if (!h) return false;
  h({ target: el, preventDefault() { }, stopPropagation() { } });
  return true;
}

/** 处理叫分 / 加倍浮层：随机点一个可用按钮 */
function handleFloat() {
  const layer = registry.floatLayer;
  if (!layer || !layer.children.length) return false;
  const panel = layer.children[0];
  const btns = panel.querySelectorAll('.btn').filter(b => !b.disabled);
  if (!btns.length) return false;
  const pick = btns[(Math.random() * btns.length) | 0];
  return click(pick);
}

/** 玩家自动操作：先提示再出牌，出不了就不要 */
function humanAct() {
  const hintBtn = registry.btnHint;
  const playBtn = registry.btnPlay;
  const passBtn = registry.btnPass;
  if (hintBtn && !hintBtn.disabled) click(hintBtn);
  if (playBtn && !playBtn.disabled) { click(playBtn); return 'play'; }
  if (passBtn && !passBtn.disabled) { click(passBtn); return 'pass'; }
  return 'none';
}

/* ============================================================
 * 5. 不变量
 * ============================================================ */

function checkInvariants() {
  const errs = [];
  // 牌数守恒
  const inHands = G.players.reduce((a, p) => a + p.hand.length, 0);
  const bottomPart = (G.landlord === -1) ? G.bottom.length : 0;
  const total = inHands + G.played.length + bottomPart;
  if (total !== 54) errs.push(`牌数不守恒: 手牌 ${inHands} + 已出 ${G.played.length} + 底牌 ${bottomPart} = ${total}`);

  // 无重复牌
  const ids = new Set();
  let dup = null;
  const scan = (arr, where) => arr.forEach(c => {
    if (ids.has(c.id)) dup = `${where} 出现重复牌 id=${c.id}`;
    ids.add(c.id);
  });
  G.players.forEach((p, i) => scan(p.hand, `座位${i}手牌`));
  scan(G.played, '已出牌');
  if (G.landlord === -1) scan(G.bottom, '底牌');
  if (dup) errs.push(dup);

  // 手牌始终有序（大牌在前）
  G.players.forEach((p, i) => {
    for (let k = 1; k < p.hand.length; k++) {
      if (p.hand[k - 1].rank < p.hand[k].rank) {
        errs.push(`座位${i} 手牌未按点数降序排列`);
        break;
      }
    }
  });

  // 回合与身份
  if (G.turn < 0 || G.turn > 2) errs.push('非法回合座位: ' + G.turn);
  if (G.phase === 'playing') {
    if (G.landlord < 0) errs.push('出牌阶段地主未确定');
    const roles = G.players.map(p => p.role);
    if (roles.filter(r => r === 'landlord').length !== 1) errs.push('地主数量不为 1');
    if (G.multiplier < 1) errs.push('倍数小于 1: ' + G.multiplier);
  }
  return errs;
}

/* ============================================================
 * 6. 跑完整对局
 * ============================================================ */
console.log('\n=== 端到端对局 ===');

const results = { games: 0, humanWins: 0, landlordWins: 0, springs: 0, steps: [] };
let gameErr = null;

/** 卡住时把关键状态一次性 dump 出来，避免靠猜 */
function snapshot() {
  const b = registry;
  return `turn=${G.turn} busy=${G.busy} landlord=${G.landlord} ` +
    `hands=[${G.players.map(p => p.hand.length).join(',')}] ` +
    `lastSeat=${G.lastSeat} combo=${G.lastCombo ? G.lastCombo.type : '-'} ` +
    `timers=${timers.length} sel=${G.selected.length} ` +
    `btn(play/pass/hint)=${b.btnPlay.disabled ? 'X' : 'O'}${b.btnPass.disabled ? 'X' : 'O'}${b.btnHint.disabled ? 'X' : 'O'} ` +
    `float=${b.floatLayer && b.floatLayer.children.length}`;
}

function playOneGame(maxFlush) {
  const startPhase = G.phase;
  let steps = 0;
  let sawPlaying = false;
  let lastSig = '';

  while (steps++ < maxFlush) {
    // 优先处理浮层（叫分 / 加倍）
    if (handleFloat()) { continue; }

    // 玩家回合：自动出牌。
    // 注意 doPlay/doPass 会同步把 G.turn 推进到下一家，但要等一段动画延时后
    // nextTurn() 才真正调用 humanTurn() 点亮按钮。「轮到玩家」和「按钮可用」
    // 之间存在时间差，此时必须推进时钟，否则会空转。
    if (G.phase === 'playing' && G.turn === 0 && !G.busy) {
      // sig 用于识别「点了按钮但状态没变」的死循环，遇到就直接推进时钟
      const sig = `${G.turn}|${G.busy}|${G.players.map(p => p.hand.length).join(',')}|${G.selected.length}`;
      if (humanAct() !== 'none' && sig !== lastSig) {
        lastSig = sig;
        const e0 = checkInvariants();
        if (e0.length) return { err: e0[0] };
        continue;
      }
      lastSig = sig;
    }

    if (G.phase === 'playing') sawPlaying = true;

    if (!flushOne()) {
      // 没有待执行任务了
      if (G.phase === 'over') break;
      return { err: '任务队列耗尽但游戏未结束（疑似流程卡死），phase=' + G.phase };
    }

    const e = checkInvariants();
    if (e.length) return { err: e[0] };

    if (G.phase === 'over') break;
  }

  if (G.phase !== 'over') {
    return { err: '在 ' + maxFlush + ' 步内未结束 phase=' + G.phase + ' | ' + snapshot() };
  }
  results.games++;
  results.steps.push(steps);
  return { ok: true, steps, sawPlaying };
}

// 允许每局最多 4000 次调度
const GAMES = Number(process.env.GAMES || (process.argv.includes('--full') ? 40 : 15));

// 进入页面先选游戏：斗地主
const modeLobby = registry.gameLobby;
ok(!!modeLobby && modeLobby.classList.contains('show'), '进入页面应先显示游戏模式大厅');
const modeBtns = modeLobby.querySelectorAll('button');
ok(modeBtns.length === 2, '游戏大厅应有 2 个游戏按钮，实际 ' + modeBtns.length);
const ddzModeBtn = modeBtns.find(b => b.dataset.game === 'ddz');
const mjModeBtn = modeBtns.find(b => b.dataset.game === 'mj');
ok(!!ddzModeBtn && !!mjModeBtn, '游戏大厅按钮 data-game 不全');
ok(ddzModeBtn._h && ddzModeBtn._h.click, '游戏按钮未绑定点击事件');
click(ddzModeBtn);
ok(!modeLobby.classList.contains('show'), '选择游戏后模式大厅应关闭');
ok(registry.ddzView.style.display !== 'none', '选择斗地主后应显示斗地主视图');
ok(registry.mjView.style.display === 'none', '选择斗地主时麻将视图应隐藏');
ok(ctx.App.current === 'ddz', 'App.current 应为 ddz');

// 选场大厅：点「高手场」开启首局
const lobbyEl = registry.lobby;
ok(!!lobbyEl && lobbyEl.classList.contains('show'), '首局开始前应停在选场大厅');
const firstRoom = lobbyEl && lobbyEl.querySelectorAll('button').find(b => b.dataset.d === 'hard');
ok(!!firstRoom, '大厅缺少高手场按钮');
click(firstRoom);
ok(!lobbyEl.classList.contains('show'), '选好场次后大厅应隐藏');
ok(G.difficulty === 'hard', '选场后难度应为 hard，实际 ' + G.difficulty);
ok(G.phase === 'bidding', '选场后应进入叫分阶段，实际 ' + G.phase);
flushOne();

let rematchNamesKept = true;
for (let i = 0; i < GAMES; i++) {
  const r = playOneGame(4000);
  if (r.err) { gameErr = r.err; console.log('  ⚠ 第 ' + (i + 1) + ' 局中断: ' + r.err); break; }

  const stats = ctx.Store.getStats();
  results.humanWins = stats.landlordWins + stats.farmerWins;

  // 结算弹窗必须出现，且能正常开始下一局
  const dialog = registry.dialog;
  if (!dialog || !dialog.innerHTML.includes('settle-title')) {
    gameErr = '第 ' + (i + 1) + ' 局结束后没有弹出结算面板';
    break;
  }
  if (G.landlord === 0) results.landlordWins = ctx.Store.getStats().landlordWins;

  // 点「再来一局」开新局：对手应是原来那两位（名字不变）
  const namesBefore = [G.players[1].name, G.players[2].name];
  const oppBefore = G.nextOpponents;
  const againBtn = dialog.querySelectorAll('.btn').find(b => b.textContent === '再来一局');
  if (!againBtn) { gameErr = '结算面板缺少「再来一局」按钮'; break; }
  click(againBtn);
  if (G.players[1].name !== namesBefore[0] || G.players[2].name !== namesBefore[1] ||
      G.nextOpponents !== oppBefore) {
    rematchNamesKept = false;
    break;
  }
  // 新局会重置为发牌态
  flushOne();
}
ok(rematchNamesKept, '「再来一局」后对手名字应保持不变');

// 结算面板应有「换个场次」按钮：点击后回到选场大厅，并重新抽取对手网名
{
  const dialog = registry.dialog;
  const swapBtn = dialog.querySelectorAll('.btn').find(b => b.textContent === '换个场次');
  ok(!!swapBtn, '结算面板缺少「换个场次」按钮');
  const oppBefore = G.nextOpponents;
  click(swapBtn);
  ok(lobbyEl.classList.contains('show'), '点「换个场次」后应回到选场大厅');
  ok(G.phase === 'lobby', '换个场次后阶段应为 lobby，实际 ' + G.phase);
  ok(!registry.overlay.classList.contains('show'), '换个场次后弹窗应关闭');
  ok(G.nextOpponents !== oppBefore, '回到大厅后应重新抽取对手网名');

  // 大厅再选「新手场」，新对手网名应落地到对局
  const easyRoom = lobbyEl.querySelectorAll('button').find(b => b.dataset.d === 'easy');
  click(easyRoom);
  ok(G.phase === 'bidding' && G.difficulty === 'easy', '换场后应以新难度开新局');
  ok(G.players[1].name === G.nextOpponents[0].name && G.players[2].name === G.nextOpponents[1].name,
    '换场后对手应使用新抽取的网名');
  ok(G.players[1].name !== '小豆' && G.players[2].name !== '阿欢', '不应再出现旧的写死网名');
  flushOne();
}

/* ============================================================
 * 6.5 麻将：模式切换 + 完整一局冒烟
 * ============================================================ */
console.log('\n=== 麻将冒烟 ===');
{
  // 左上角 🎮 → 游戏模式大厅
  click(registry.btnGameMode);
  ok(modeLobby.classList.contains('show'), '点 🎮 应回到游戏模式大厅');
  ok(G.phase === 'lobby', '切走后斗地主应挂起，实际 ' + G.phase);

  // 选麻将
  click(mjModeBtn);
  ok(registry.mjView.style.display !== 'none', '选择麻将后应显示麻将视图');
  ok(registry.ddzView.style.display === 'none', '选择麻将时斗地主视图应隐藏');
  ok(ctx.App.current === 'mj', 'App.current 应为 mj');
  const mjLobbyEl = registry.mjLobby;
  ok(mjLobbyEl.classList.contains('show'), '进入麻将应先显示麻将选场大厅');
  const G2 = ctx.MjGame.G;
  ok(G2.phase === 'lobby', '麻将初始应为 lobby，实际 ' + G2.phase);

  // 选新手场开局
  const mjRoom = mjLobbyEl.querySelectorAll('button').find(b => b.dataset.d === 'easy');
  ok(!!mjRoom, '麻将大厅缺少新手场按钮');
  click(mjRoom);
  ok(G2.phase === 'playing', '麻将选场后应进入对局，实际 ' + G2.phase);
  ok(G2.players.length === 4 && G2.players.every(p => p.hand.length === 13),
    '麻将发牌应为 4 家各 13 张');
  ok(G2.wall.length === 84, `发牌后牌墙应为 84 张，实际 ${G2.wall.length}`);
  ok(G2.dealer >= 0 && G2.dealer <= 3, '庄家座位非法: ' + G2.dealer);

  // 驱动完整一局：玩家永远打最后一张，争抢一律过
  let mjSteps = 0, mjDone = false;
  while (mjSteps++ < 8000) {
    if (G2.phase === 'over') { mjDone = true; break; }
    const my = G2.players[0];
    if (G2.phase === 'playing' && G2.turn === 0 && !G2.busy && my.hand.length % 3 === 2) {
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
    if (!flushOne()) break;
  }
  ok(mjDone, '麻将一局应能跑到终局（步数耗尽 phase=' + G2.phase +
    ' wall=' + G2.wall.length + ' hands=' + G2.players.map(p => p.hand.length).join(',') + '）');
  ok(G2.phase === 'over', '麻将终局阶段应为 over，实际 ' + G2.phase);
  ok(registry.overlay.classList.contains('show'), '麻将终局应弹出结算面板');
  const mjSwap = registry.dialog.querySelectorAll('.btn').find(b => b.textContent === '换个场次');
  ok(!!mjSwap, '麻将结算面板缺少「换个场次」按钮');
  click(mjSwap);
  ok(registry.mjLobby.classList.contains('show'), '麻将「换个场次」应回到麻将选场大厅');
  ok(!registry.overlay.classList.contains('show'), '麻将回大厅后弹窗应关闭');

  // 切回斗地主
  click(registry.btnGameMode);
  ok(modeLobby.classList.contains('show'), '再次点 🎮 应回到游戏模式大厅');
  click(ddzModeBtn);
  ok(ctx.App.current === 'ddz', '切回后 App.current 应为 ddz');
  ok(registry.lobby.classList.contains('show'), '切回斗地主应显示其选场大厅');
  ok(registry.mjView.style.display === 'none', '切回斗地主后麻将视图应隐藏');
  ok(G2.phase === 'lobby', '切走后麻将应挂起，实际 ' + G2.phase);
}

ok(!gameErr, '对局流程错误: ' + gameErr);
console.log(`  连续完成 ${results.games} 局，平均每局 ${(results.steps.reduce((a, b) => a + b, 0) / Math.max(1, results.games)).toFixed(0)} 次调度`);

/* ============================================================
 * 7. 渲染层
 * ============================================================ */
console.log('\n=== 渲染层 ===');

ok(domOps > 2000, `DOM 操作次数偏少（${domOps}），渲染层可能没真正执行`);
console.log(`  累计 DOM 写入 ${domOps} 次`);

// 手牌元素数量应与实际手牌一致
const handEls = registry.myHand.children.length;
ok(handEls === G.players[0].hand.length,
  `手牌 DOM 数量 ${handEls} 与实际手牌 ${G.players[0].hand.length} 不一致`);

// 记牌器格子数应为 15
const counterCells = registry.counterGrid.querySelectorAll('.counter-cell').length;
ok(counterCells === 15, `记牌器格子数应为 15，实际 ${counterCells}`);

// 三个座位信息框都要渲染出来
[0, 1, 2].forEach(s => {
  const box = registry['box-' + s];
  ok(box.innerHTML.includes('avatar'), `座位 ${s} 信息框未渲染`);
});

// 底牌区 3 张
ok(registry.bottomCards.children.length === 3, '底牌区应显示 3 张牌');

// 出牌槽位存在
ok(!!ctx.UI.DOM.slots[0] && !!ctx.UI.DOM.slots[1] && !!ctx.UI.DOM.slots[2], '出牌槽位未正确绑定');

/* ============================================================
 * 8. 交互：选场大厅 / 音效 / 弹窗 / 快捷键
 * ============================================================ */
console.log('\n=== 交互 ===');

// 初始应停在选场大厅，等玩家选场次
const lobby = registry.lobby;
ok(!!lobby, '选场大厅元素不存在');
ok(lobby.classList.contains('show'), '进入游戏后应先显示选场大厅');
ok(G.phase === 'lobby', '初始阶段应为 lobby，实际 ' + G.phase);
const roomBtns = lobby.querySelectorAll('button');
ok(roomBtns.length === 3, '大厅应有 3 个场次按钮，实际 ' + roomBtns.length);
ok(roomBtns.every(b => b._h && b._h.click), '场次按钮未绑定点击事件');
ok(roomBtns.some(b => b.dataset.d === 'easy') && roomBtns.some(b => b.dataset.d === 'hard') &&
  roomBtns.some(b => b.dataset.d === 'master'), '大厅场次按钮 data-d 不全');

// 顶栏不应再有难度切换按钮
ok(!registry.diffSeg, '顶栏的难度切换按钮应已删除');

// 🗣 开关：音效 + 语音播报一起开关
const voiceBtn = registry.btnVoice;
ok(!!(voiceBtn && voiceBtn._h && voiceBtn._h.click), '语音按钮未绑定事件');
const vBefore = ctx.Voice.isEnabled();
click(voiceBtn);
ok(ctx.Voice.isEnabled() === !vBefore, '语音开关未生效');
ok(ctx.Sound.isEnabled() === !vBefore, '语音开关应同时控制音效');
click(voiceBtn);
ok(ctx.Voice.isEnabled() === vBefore, '语音开关未恢复');
ok(!registry.btnSound, '🔊 一键静音按钮应已删除（音效并入 🗣）');

// 战绩弹窗
click(registry.btnStats);
ok(registry.overlay.classList.contains('show'), '战绩弹窗未打开');
ok(registry.dialog.innerHTML.includes('战 绩 统 计'), '战绩弹窗内容不正确');
const closeBtn = registry.dialog.querySelectorAll('.btn').find(b => b.textContent === '关闭');
ok(!!closeBtn, '战绩弹窗缺少关闭按钮');
click(closeBtn);

// 规则弹窗
click(registry.btnHelp);
ok(registry.dialog.innerHTML.includes('玩 法 规 则'), '规则弹窗内容不正确');
click(registry.dialog.querySelectorAll('.btn').find(b => b.textContent === '知道了'));
ok(!registry.overlay.classList.contains('show'), '弹窗未关闭');

// 战绩持久化
const st = ctx.Store.getStats();
ok(st.games === results.games, `战绩场次 ${st.games} 与对局数 ${results.games} 不一致`);
ok(st.landlordGames + st.farmerGames === results.games, '地主/农民场次之和与总场次不符');
ok(ctx.Store.persistent === true, 'localStorage 未生效');

// 快捷键
const kd = documentStub._h && documentStub._h.keydown;
ok(!!kd, '未绑定键盘事件');

/* ============================================================
 * 9. 边界场景
 * ============================================================ */
console.log('\n=== 边界场景 ===');

function resetTimers() { timers = []; }

/** 在浮层里点指定文字的按钮；没有该按钮则返回 false */
function clickFloatByText(text) {
  const layer = registry.floatLayer;
  if (!layer || !layer.children.length) return false;
  const btns = layer.children[0].querySelectorAll('.btn').filter(b => !b.disabled);
  const target = btns.find(b => b.textContent === text);
  if (!target) return false;
  return click(target);
}

/* 场景 A：三家都不叫 → 应触发重新发牌（临时让 AI 也不叫，保证可复现） */
const realDecideBid = ctx.AI.decideBid;
ctx.AI.decideBid = function () { return 0; };
resetTimers();
ctx.Game.newGame();
const genBefore = G.gen;
let guard = 0;
let redealed = false;
while (guard++ < 400) {
  if (clickFloatByText('不叫')) {
    if (G.gen > genBefore) { redealed = true; break; }   // newGame 会 +1 局次令牌
    continue;
  }
  if (!flushOne()) break;
}
ctx.AI.decideBid = realDecideBid;
ok(redealed, '三家都不叫后没有重新发牌（phase=' + G.phase + '）');
ok(G.phase === 'bidding', '重发后应回到叫分阶段，实际 ' + G.phase);
ok(G.players[0].hand.length === 17, '重发后手牌应为 17 张，实际 ' + G.players[0].hand.length);

/* 场景 B：正常叫分 → 加倍 → 出牌，流程不应卡住 */
guard = 0;
while (guard++ < 600) {
  if (G.phase === 'playing' && G.turn === 0 && !G.busy) { humanAct(); continue; }
  if (handleFloat()) continue;
  if (!flushOne()) break;
  if (G.phase === 'over') break;
}
ok(['doubling', 'playing', 'over'].includes(G.phase),
  '叫分后流程卡住，phase=' + G.phase);

// 超大手牌（地主 20 张）渲染不报错
let renderErr = null;
try {
  const bigHand = ctx.Cards.sortCards(ctx.Cards.makeDeck().slice(0, 20));
  ctx.UI.renderHand(bigHand, [bigHand[0].id], true);
  ctx.UI.renderCounter([], bigHand);
} catch (e) { renderErr = e; }
ok(!renderErr, '20 张手牌渲染异常: ' + (renderErr && renderErr.message));

// 王炸特效路径
let fxErr = null;
try {
  ctx.UI.bombEffect();
  ctx.UI.springBanner('春 天');
  ctx.UI.toast('测试');
  ctx.UI.showPlay(1, ctx.Cards.makeDeck().slice(52, 54), ctx.Cards.parse(ctx.Cards.makeDeck().slice(52, 54)), { bomb: true });
} catch (e) { fxErr = e; }
ok(!fxErr, '特效渲染异常: ' + (fxErr && fxErr.message));

// 空手牌拆解
ok(ctx.Decompose.minHands([]) === 0, '空手牌拆解应为 0 手');
ok(ctx.Decompose.decompose([]).count === 0, '空手牌拆解结果应为空');

/* ============================================================
 * 10. 音效合成（装一个 AudioContext 桩，真正跑一遍合成代码）
 *
 * 之前桩里没有 AudioContext，audio.js 全部走了静默降级分支，
 * tone() / noise() / chord() 这些真正的合成代码一次都没执行过 ——
 * 相当于「渲染函数从未运行」。这里必须补上。
 * ============================================================ */
console.log('\n=== 音效合成 ===');

let AC_OK = true;
function makeAudioStub() {
  const stat = { osc: 0, gain: 0, bufferSrc: 0, filter: 0, start: 0, stop: 0 };
  const param = () => ({
    value: 0,
    setValueAtTime() { return this; },
    exponentialRampToValueAtTime(v) {
      if (!(v > 0)) throw new Error('exponentialRamp 目标值必须为正，收到 ' + v);
      return this;
    },
    linearRampToValueAtTime() { return this; },
    cancelScheduledValues() { return this; }
  });
  const mk = (kind) => ({
    _kind: kind,
    type: 'sine', frequency: param(), gain: param(), Q: param(), detune: param(),
    buffer: null, loop: false,
    connect() { return this; }, disconnect() { },
    start() { stat.start++; }, stop() { stat.stop++; }
  });
  class FakeAC {
    constructor() {
      this.sampleRate = 44100;
      this.state = 'running';
      this.destination = mk('destination');
      this._t = 0;
    }
    get currentTime() { return vnow / 1000; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    createGain() { stat.gain++; return mk('gain'); }
    createOscillator() { stat.osc++; return mk('osc'); }
    createBufferSource() { stat.bufferSrc++; return mk('src'); }
    createBiquadFilter() { stat.filter++; return mk('filter'); }
    createBuffer(channels, len) {
      const data = new Float32Array(len);
      return { length: len, numberOfChannels: channels, getChannelData: () => data };
    }
  }
  return { FakeAC, stat };
}

const { FakeAC, stat } = makeAudioStub();
ctx.AudioContext = FakeAC;

// 逐个触发全部音效，任何一个抛异常都算失败
const SOUND_NAMES = ['deal', 'select', 'deselect', 'play', 'pass', 'bomb',
  'rocket', 'double', 'spring', 'win', 'lose', 'turn', 'warn'];
let soundErr = null;
try {
  ctx.Sound.setEnabled(true);
  for (const n of SOUND_NAMES) ctx.Sound.play(n);
  for (let i = 0; i <= 3; i++) ctx.Sound.play('bid', i);   // 叫分 0~3 分
} catch (e) { soundErr = e; }
ok(!soundErr, '音效合成抛异常: ' + (soundErr && soundErr.message));

console.log(`  振荡器 ${stat.osc} / 增益 ${stat.gain} / 噪声源 ${stat.bufferSrc} / 滤波器 ${stat.filter} / start ${stat.start}`);
// 精确计数：17 次调用合计应产生 39 个振荡器
//   单音 select/deselect/play/pass 各 1，warn 1，turn 2，bomb 3，rocket 3，
//   double(chord3) 3，spring(chord4) 4，win(4音+chord4) 8，lose 4，deal 为纯噪声 0，
//   bid×4（0~3 分）共 7。总计 39。
// 改动音效时请同步更新此处的期望值。
ok(stat.osc === 39, `振荡器数量应为 39，实际 ${stat.osc}（音效合成不完整或已改动）`);
// 增益节点 = 每个音源各一个 + init() 创建的主输出增益
ok(stat.gain === stat.osc + stat.bufferSrc + 1,
  `增益节点应为音源数+1（主输出），实际 增益${stat.gain} 音源${stat.osc + stat.bufferSrc}`);
ok(stat.bufferSrc === 4, `噪声源应为 4（发牌/出牌/炸弹/王炸），实际 ${stat.bufferSrc}`);
ok(stat.filter === 4, `滤波器应为 4，实际 ${stat.filter}`);
ok(stat.start === stat.stop && stat.start === stat.osc + stat.bufferSrc,
  `start(${stat.start}) / stop(${stat.stop}) / 音源(${stat.osc + stat.bufferSrc}) 三者应相等`);

// 关闭音效后不应再产生任何节点
const oscBefore = stat.osc;
ctx.Sound.setEnabled(false);
for (const n of SOUND_NAMES) ctx.Sound.play(n);
ok(stat.osc === oscBefore, '音效关闭后仍在创建音频节点');
ctx.Sound.setEnabled(true);

// 没有 AudioContext 的环境必须静默降级而不是崩溃
let degradeErr = null;
try {
  const saved = ctx.AudioContext;
  delete ctx.AudioContext;
  ctx.Sound.setEnabled(true);
  for (const n of SOUND_NAMES) ctx.Sound.play(n);
  ctx.AudioContext = saved;
} catch (e) { degradeErr = e; }
ok(!degradeErr, '无 AudioContext 时未静默降级: ' + (degradeErr && degradeErr.message));

/* ============================================================
 * 11. 存档模块
 * ============================================================ */
console.log('\n=== 存档 ===');

const rawStore = ctx.localStorage;
ok(rawStore.getItem('doudizhu.stats.v1') !== null, '战绩未写入 localStorage');

const s0 = ctx.Store.getStats();
ok(s0.games === results.games, `战绩场次 ${s0.games} 与实际对局 ${results.games} 不符`);

// 读写往返
ctx.Store.setPrefs({ difficulty: 'hard', sound: false, baseScore: 200 });
const p1 = ctx.Store.getPrefs();
ok(p1.difficulty === 'hard' && p1.sound === false && p1.baseScore === 200,
  `偏好读写往返失败: ${JSON.stringify(p1)}`);

// 脏数据容错：JSON 损坏时应回落默认值而不是崩溃
let corruptErr = null;
try {
  rawStore.setItem('doudizhu.stats.v1', '{这不是合法JSON');
  const s2 = ctx.Store.getStats();
  ok(s2.games === 0, '脏数据未回落默认值');
} catch (e) { corruptErr = e; }
ok(!corruptErr, '脏存档数据导致崩溃: ' + (corruptErr && corruptErr.message));

// 清空战绩
ctx.Store.resetStats();
ok(ctx.Store.getStats().games === 0, '清空战绩失败');

// 记一局并校验各字段
ctx.Store.recordGame({ role: 'landlord', win: true, delta: 400, bombs: 2, spring: true });
const s3 = ctx.Store.getStats();
ok(s3.landlordGames === 1 && s3.landlordWins === 1, '地主场次/胜场统计错误');
ok(s3.score === 400, '积分累计错误: ' + s3.score);
ok(s3.streak === 1 && s3.bestStreak === 1, '连胜统计错误');
ok(s3.bombs === 2 && s3.springs === 1, '炸弹/春天统计错误');
ctx.Store.recordGame({ role: 'farmer', win: false, delta: -100, bombs: 0, spring: false });
const s4 = ctx.Store.getStats();
ok(s4.streak === 0 && s4.bestStreak === 1, '失败后应清空连胜但保留最高连胜');
ok(s4.farmerGames === 1 && s4.farmerWins === 0, '农民场次统计错误');

/* ============================================================
 * 10.5 背景音乐（复用上面的 AudioContext 桩）
 * ============================================================ */
console.log('\n=== 背景音乐 ===');

if (!ctx.Bgm) {
  ok(false, 'Bgm 模块未挂载');
} else {
  const preOsc = stat.osc, preBuf = stat.bufferSrc, preStart = stat.start;

  // 乐谱完整性：两条情绪都应铺满整个循环，且每步都有事件
  ['calm', 'tense'].forEach(function (mood) {
    const p = ctx.Bgm._patterns[mood];
    ok(p.loopSteps === 64, `[${mood}] 循环长度应为 64 步，实际 ${p.loopSteps}`);
    let filled = 0;
    for (let i = 0; i < p.loopSteps; i++) if (p.events[i] && p.events[i].length) filled++;
    ok(filled === p.loopSteps, `[${mood}] ${p.loopSteps} 步中只有 ${filled} 步有事件，旋律有空洞`);
    ok(p.bpm > 80 && p.bpm < 180, `[${mood}] BPM 异常: ${p.bpm}`);
  });

  // 启动并手动推进调度，验证真的在产生音符
  ctx.Bgm.setEnabled(true);
  ok(ctx.Bgm.isEnabled() && ctx.Bgm.isPlaying(), '音乐未能启动');
  for (let i = 0; i < 220; i++) { vnow += 100; ctx.Bgm._tick(); }

  const dOsc = stat.osc - preOsc, dBuf = stat.bufferSrc - preBuf, dStart = stat.start - preStart;
  console.log(`  推进 22 秒虚拟时间：振荡器 +${dOsc}，噪声源 +${dBuf}`);
  ok(dOsc >= 60, `音乐调度产生的振荡器过少（+${dOsc}），旋律可能没真正响`);
  ok(dBuf >= 40, `音乐调度的噪声源过少（+${dBuf}），打击乐没跑到`);
  ok(dStart === dOsc + dBuf, `音乐节点 start(${dStart}) 与创建数(${dOsc + dBuf})不配平`);

  // 情绪切换：应在小节边界生效
  ctx.Bgm.setMood('tense');
  for (let i = 0; i < 60; i++) { vnow += 100; ctx.Bgm._tick(); }
  ok(ctx.Bgm.getMood() === 'tense', '切换到紧张情绪未生效，当前 ' + ctx.Bgm.getMood());
  ctx.Bgm.setMood('calm');
  for (let i = 0; i < 60; i++) { vnow += 100; ctx.Bgm._tick(); }
  ok(ctx.Bgm.getMood() === 'calm', '切换回轻快情绪未生效');

  // 音量
  ctx.Bgm.setVolume(0.85);
  ok(Math.abs(ctx.Bgm.getVolume() - 0.85) < 1e-9, '音量设置未生效');
  ctx.Bgm.setVolume(5);      // 越界应被夹到 1
  ok(ctx.Bgm.getVolume() === 1, '音量越界未夹取');
  ctx.Bgm.setVolume(-2);
  ok(ctx.Bgm.getVolume() === 0, '负音量未夹取到 0');
  ctx.Bgm.setVolume(0.4);

  // 关闭后应停止调度
  ctx.Bgm.setEnabled(false);
  ok(!ctx.Bgm.isPlaying(), '关闭音乐后仍在播放');
  const stopOsc = stat.osc;
  for (let i = 0; i < 20; i++) { vnow += 100; ctx.Bgm._tick(); }
  ok(stat.osc === stopOsc, '关闭音乐后仍在创建音频节点');

  // 恢复默认，供后续用例使用
  ctx.Bgm.setVolume(0.4);
  ctx.Bgm.setEnabled(true);
  for (let i = 0; i < 5; i++) { vnow += 100; ctx.Bgm._tick(); }
  ctx.Bgm.setEnabled(false);
}

/* ============================================================
 * 12. 语音播报与拖动连选
 * ============================================================ */
console.log('\n=== 语音播报 ===');

ok(!!ctx.Voice, 'Voice 模块未挂载');
const mkC = (type, main, len) => ({ type, main, len: len || 1, cards: [] });
const CTC = ctx.Cards.CT;
ok(ctx.Voice.comboText(mkC(CTC.PAIR, 15)) === '对二', '「对二」播报文本错误: ' + ctx.Voice.comboText(mkC(CTC.PAIR, 15)));
ok(ctx.Voice.comboText(mkC(CTC.TRIPLE_ONE, 10)) === '三带一', '「三带一」播报文本错误');
ok(ctx.Voice.comboText(mkC(CTC.TRIPLE_PAIR, 9)) === '三带二', '「三带二」播报文本错误');
ok(ctx.Voice.comboText(mkC(CTC.BOMB, 8)) === '炸弹！', '「炸弹」播报文本错误');
ok(ctx.Voice.comboText(mkC(CTC.ROCKET, 17)) === '王炸！', '「王炸」播报文本错误');
ok(ctx.Voice.comboText(mkC(CTC.SINGLE, 14)) === '尖', '单张A应为「尖」');
ok(ctx.Voice.comboText(mkC(CTC.SINGLE, 17)) === '大王！', '单张大王应带情绪');
ok(ctx.Voice.comboText(mkC(CTC.PAIR, 3)) === '对三', '「对三」播报文本错误');
ok(ctx.Voice.comboText(mkC(CTC.STRAIGHT, 9, 5)) === '顺子',
  '顺子播报文本错误: ' + ctx.Voice.comboText(mkC(CTC.STRAIGHT, 9, 5)));
ok(ctx.Voice.comboText(mkC(CTC.DOUBLE_STRAIGHT, 7, 3)) === '连对',
  '连对播报文本错误: ' + ctx.Voice.comboText(mkC(CTC.DOUBLE_STRAIGHT, 7, 3)));
ok(ctx.Voice.comboText(mkC(CTC.AIRPLANE_ONE, 10, 2)) === '飞机带单', '「飞机带单」播报文本错误');
ok(ctx.Voice.comboText(mkC(CTC.FOUR_TWO_PAIR, 12)) === '四带两对', '「四带两对」播报文本错误');
ok(ctx.Voice.comboText(null) === '', '空牌型应返回空文本');

// 没有 speechSynthesis 的环境必须静默降级而不是崩溃
let voiceErr = null;
try {
  ctx.Voice.announcePlay(0, mkC(CTC.PAIR, 15));
  ctx.Voice.announcePlay(1, mkC(CTC.BOMB, 3));
  ctx.Voice.announcePlay(2, null);
  ctx.Voice.announcePass(2);
  ctx.Voice.announceBid(0, 3);
  ctx.Voice.announceBid(1, 0);
  ctx.Voice.announceLandlord(2);
  ctx.Voice.announceDouble(0, 1);
  ctx.Voice.announceDouble(1, 0);
  ctx.Voice.announceDouble(2, 2);
  ctx.Voice.setEnabled(false);
  ok(ctx.Voice.isEnabled() === false, '语音开关未生效');
  ctx.Voice.setEnabled(true);
} catch (e) { voiceErr = e; }
ok(!voiceErr, '无 speechSynthesis 时未静默降级: ' + (voiceErr && voiceErr.message));

console.log('\n=== 拖动连选 ===');

// 给桩元素布上矩形：第 i 张可见条带 = [40+30i, 40+30(i+1))，模拟负边距叠放
function layoutHand(el) {
  for (let i = 0; i < el.children.length; i++) {
    const idx = i;
    el.children[i].getBoundingClientRect = () => ({
      left: 40 + idx * 30, right: 40 + idx * 30 + 80, top: 100, bottom: 240, width: 80, height: 140
    });
  }
}

// UI 层：渲染一手牌，模拟「按住第 2 张划到第 6 张」
const dragHand = ctx.Cards.sortCards(ctx.Cards.makeDeck().slice(0, 10));
ctx.UI.renderHand(dragHand, [], true);
const handEl = ctx.UI.DOM.myHand;
layoutHand(handEl);
ok(handEl.children.length === 10, '拖动测试手牌渲染数量不对: ' + handEl.children.length);
ok(typeof handEl.children[0]._h.pointerdown === 'function', '手牌未挂 pointerdown 拖动事件');
ok(typeof handEl.children[0]._h.click === 'function', '手牌单击事件被拖动逻辑顶掉');

let dragErr = null;
try {
  handEl.children[1]._h.pointerdown({ pointerId: 7, button: 0 });
  // 快速甩动：指针直接跳到第 4 张（x=130）、再跳到第 6 张（x=190），中间的 3、5 也应补选
  documentStub._h.pointermove({ pointerId: 7, clientX: 130, clientY: 100 });
  documentStub._h.pointermove({ pointerId: 7, clientX: 190, clientY: 100 });
  documentStub._h.pointerup({ pointerId: 7 });
} catch (e) { dragErr = e; }
ok(!dragErr, '拖动连选抛异常: ' + (dragErr && dragErr.stack));
for (let i = 1; i <= 5; i++) {
  ok(handEl.children[i].classList.contains('selected'), `划过的第 ${i} 张未被连选`);
}
ok(!handEl.children[0].classList.contains('selected'), '没划到的牌不应被选中');
ok(!handEl.children[9].classList.contains('selected'), '没划到的牌不应被选中');

// 精确坐标：x 落在哪张牌的可见条带内就连选哪张，不能偏到右边的叠放牌上
ctx.UI.renderHand(dragHand, [], true);
layoutHand(handEl);
let preciseErr = null;
try {
  handEl.children[3]._h.pointerdown({ pointerId: 12, button: 0 });
  // x=115 落在第 2 张的可见条带（[100,130)），而非叠在其上的第 3/4 张
  documentStub._h.pointermove({ pointerId: 12, clientX: 115, clientY: 100 });
  documentStub._h.pointerup({ pointerId: 12 });
} catch (e) { preciseErr = e; }
ok(!preciseErr, '精确命中路径抛异常: ' + (preciseErr && preciseErr.stack));
ok(handEl.children[2].classList.contains('selected') &&
  !handEl.children[4].classList.contains('selected'), 'x=115 应命中第 3 张的可见条带（而非叠放其上的牌）');

// 反向取消：按住已选中的牌拖动，划过的牌全部取消选中
ctx.UI.renderHand(dragHand, dragHand.slice(1, 5).map(c => c.id), true);
layoutHand(handEl);
let deselectErr = null;
try {
  handEl.children[2]._h.pointerdown({ pointerId: 13, button: 0 });
  documentStub._h.pointermove({ pointerId: 13, clientX: 190, clientY: 100 });   // 划到第 6 张
  documentStub._h.pointerup({ pointerId: 13 });
} catch (e) { deselectErr = e; }
ok(!deselectErr, '连选取消路径抛异常: ' + (deselectErr && deselectErr.stack));
for (let i = 2; i <= 5; i++) {
  ok(!handEl.children[i].classList.contains('selected'), `反向拖动后第 ${i} 张应被取消选中`);
}
ok(handEl.children[1].classList.contains('selected'), '没划到的已选牌应保持选中');

// 原地按下松开（没划到别的牌）不算连选，也不应崩溃
let clickErr = null;
try {
  handEl.children[8]._h.pointerdown({ pointerId: 9, button: 0 });
  documentStub._h.pointerup({ pointerId: 9 });
} catch (e) { clickErr = e; }
ok(!clickErr, '原地单击路径抛异常: ' + (clickErr && clickErr.message));
ok(!handEl.children[8].classList.contains('selected'), '原地单击不应走连选路径');

// 游戏层：连选结果应合并进 G.selected（守卫 + 索引映射）
let g = ctx.Game.G;
if (g.players[0].hand.length < 8) ctx.Game.newGame();
g = ctx.Game.G;
g.phase = 'playing'; g.turn = 0; g.busy = false; g.selected = [];
const liveHand = g.players[0].hand;
ctx.UI.renderHand(liveHand, [], true);
layoutHand(ctx.UI.DOM.myHand);
let commitErr = null;
try {
  ctx.UI.DOM.myHand.children[2]._h.pointerdown({ pointerId: 11, button: 0 });
  documentStub._h.pointermove({ pointerId: 11, clientX: 190, clientY: 100 });  // 划到第 6 张
  documentStub._h.pointerup({ pointerId: 11 });
} catch (e) { commitErr = e; }
ok(!commitErr, '连选提交抛异常: ' + (commitErr && commitErr.stack));
ok(g.selected.length === 4, `游戏层连选应提交 4 张，实际 ${g.selected.length}`);
for (let i = 2; i <= 5; i++) {
  ok(g.selected.includes(liveHand[i].id), `第 ${i} 张未被提交进选牌`);
}

// 游戏层：反向连选应从 G.selected 移除
g.selected = liveHand.slice(1, 6).map(c => c.id);
ctx.UI.renderHand(liveHand, g.selected, true);
layoutHand(ctx.UI.DOM.myHand);
let decErr = null;
try {
  ctx.UI.DOM.myHand.children[2]._h.pointerdown({ pointerId: 14, button: 0 });
  documentStub._h.pointermove({ pointerId: 14, clientX: 190, clientY: 100 });  // 划到第 6 张
  documentStub._h.pointerup({ pointerId: 14 });
} catch (e) { decErr = e; }
ok(!decErr, '反向连选提交抛异常: ' + (decErr && decErr.stack));
ok(g.selected.length === 1 && g.selected.includes(liveHand[1].id),
  `反向连选后应只剩 1 张（第 2 张），实际 ${g.selected.length}`);
for (let i = 2; i <= 5; i++) {
  ok(!g.selected.includes(liveHand[i].id), `第 ${i} 张应被移出选牌`);
}

/* ============================================================
 * 汇总
 * ============================================================ */

function report() {
  console.log('\n' + '='.repeat(60));
  if (fail === 0) {
    console.log(`✅ 全部通过：${pass} 项断言`);
  } else {
    console.log(`❌ 失败 ${fail} 项 / 共 ${pass + fail} 项`);
    failures.slice(0, 25).forEach(f => console.log('  - ' + f));
    process.exitCode = 1;
  }
}
report();
