/* 斗地主 —— 纯前端单机斗地主游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * pimc-diag.js —— PIMC 接管诊断：求解触发时的规模分布 + 决策 tag 分布
 *
 * 回答的问题：30 局 mini duel 平均 250 节点/次，求解器到底在什么规模被触发？
 * 如果全部落在 total ≤ 10 的极小残局，说明 mx≤12 的门控在实战中
 * 「首触发即小残局」或大量决策被早退路径分流。
 *
 * 用法：node tests/pimc-diag.js [局数]
 * ========================================================================== */
'use strict';

const Cards = require('../js/cards.js');
const AI = require('../js/ai.js');

AI.FEAT.pimc = true;
AI.FEAT.pimcMax = 12;

const N = Number(process.argv[2] || 30);
const SEED = 20260830;

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* ---------- 统计容器 ---------- */
function bucketTotal(t) {
  if (t <= 6) return 'a≤6';
  if (t <= 9) return 'b7-9';
  if (t <= 12) return 'c10-12';
  if (t <= 16) return 'd13-16';
  if (t <= 20) return 'e17-20';
  if (t <= 28) return 'f21-28';
  return 'g>28';
}
function bucketMx(m) {
  if (m <= 6) return 'a≤6';
  if (m <= 9) return 'b7-9';
  if (m <= 12) return 'c10-12';
  return 'd>12';
}
const solveByTotal = {};   // 求解触发时三家总牌数分布
const solveByMx = {};      // 求解触发时最大手牌分布
let solveCount = 0;
AI.PIMC_STATS.onSolve = function (lens) {
  solveCount++;
  const total = lens[0] + lens[1] + lens[2];
  const mx = Math.max(lens[0], lens[1], lens[2]);
  const bt = bucketTotal(total), bm = bucketMx(mx);
  solveByTotal[bt] = (solveByTotal[bt] || 0) + 1;
  solveByMx[bm] = (solveByMx[bm] || 0) + 1;
};

/* master 决策 tag 分布（按 mx 分桶）；真决策另记 [mx,total] 供门控分析 */
const tagByMx = {};
const realDecidePts = [];   // { mx, total, tag }：master 非 pass 的真决策
const origDecide = AI.decidePlay;
AI.decidePlay = function (ctx) {
  const isMaster = ctx.difficulty === 'master';
  const r = origDecide(ctx);
  if (isMaster) {
    const mx = Math.max.apply(null, ctx.counts);
    const total = ctx.counts.reduce(function (a, b) { return a + b; }, 0);
    const tag = (r && r.tag) ? r.tag : (r ? 'other' : 'pass');
    const key = bucketMx(mx) + ' ' + tag;
    tagByMx[key] = (tagByMx[key] || 0) + 1;
    if (tag !== 'pass') realDecidePts.push({ mx: mx, total: total, tag: tag });
  }
  return r;
};

/* ---------- 对局（复刻 duel.js：master@0 vs hard 1/2，地主轮换） ---------- */
function playGame(i) {
  const deck = Cards.shuffle(Cards.makeDeck(), mulberry32(SEED + i * 7919));
  const hands = [deck.slice(0, 17), deck.slice(17, 34), deck.slice(34, 51)];
  const bottom = deck.slice(51);
  const landlord = i % 3;
  hands[landlord] = Cards.sortCards(hands[landlord].concat(bottom));
  const roles = [0, 1, 2].map(s => (s === landlord ? 'landlord' : 'farmer'));

  const played = [];
  let turn = landlord;
  let lastCombo = null, lastSeat = null, passCount = 0, winner = -1;

  for (let guard = 0; guard < 800; guard++) {
    const seat = turn;
    const hand = hands[seat];
    const teammateSeat = roles[seat] === 'farmer'
      ? [0, 1, 2].find(s => s !== seat && roles[s] === 'farmer') : landlord;

    const res = AI.decidePlay({
      difficulty: seat === 0 ? 'master' : 'hard',
      hand, seat, role: roles[seat], landlordSeat: landlord, teammateSeat,
      lastCombo: lastSeat === seat ? null : lastCombo,
      lastSeat, counts: hands.map(h => h.length), played,
      hands: seat === 0 ? hands.map(h => h.slice()) : null
    });

    if (res && res.cards && res.cards.length) {
      const combo = Cards.parse(res.cards);
      if (!combo) return null;
      if (lastCombo && !Cards.canBeat(combo, lastCombo)) return null;
      const ids = new Set(res.cards.map(c => c.id));
      hands[seat] = hand.filter(c => !ids.has(c.id));
      played.push(...res.cards);
      lastCombo = combo; lastSeat = seat; passCount = 0;
      if (!hands[seat].length) { winner = seat; break; }
    } else {
      passCount++;
      if (lastCombo && passCount >= 2) { lastCombo = null; passCount = 0; }
    }
    turn = (turn + 1) % 3;
  }
  return winner >= 0 ? winner : -1;
}

const t0 = Date.now();
let done = 0, skipped = 0, wins0 = 0;
for (let i = 0; i < N; i++) {
  const w = playGame(i);
  if (w < 0) { skipped++; continue; }
  done++;
  if (w === 0) wins0++;
}

/* ---------- 输出 ---------- */
function printMap(m, label) {
  console.log(label);
  const keys = Object.keys(m).sort();
  for (const k of keys) {
    const pct = (100 * m[k] / Math.max(1, solveCount || 1)).toFixed(1);
    console.log('  ' + k.padEnd(12) + m[k] + (label.indexOf('求解') >= 0 ? '  (' + pct + '%)' : ''));
  }
  if (!keys.length) console.log('  (无)');
}

console.log('局数: ' + done + ' 完成 / ' + skipped + ' 跳过   0号位(/master)胜率 ' +
  (100 * wins0 / Math.max(1, done)).toFixed(1) + '%   耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
console.log('PIMC 求解总次数: ' + solveCount + '  (' + (solveCount / Math.max(1, done)).toFixed(1) + ' /局)');
console.log('PIMC 节点总数: ' + AI.PIMC_STATS.nodes + '  平均 ' +
  (AI.PIMC_STATS.nodes / Math.max(1, solveCount)).toFixed(0) + ' /次');
printMap(solveByTotal, '—— 求解触发时三家总牌数分布 ——');
printMap(solveByMx, '—— 求解触发时最大手牌(mx)分布 ——');
printMap(tagByMx, '—— master 决策 tag 分布（按 mx 分桶）——');

/* 假设性门控分析：若改为「total ≤ T」能接管多少真决策点 */
const totalBuckets = {};
for (const p of realDecidePts) {
  const bt = bucketTotal(p.total);
  if (!totalBuckets[bt]) totalBuckets[bt] = { n: 0, over12: 0 };
  totalBuckets[bt].n++;
  if (p.mx > 12) totalBuckets[bt].over12++;
}
console.log('—— master 真决策(total×mx>12 占比) ——');
for (const k of Object.keys(totalBuckets).sort()) {
  const b = totalBuckets[k];
  console.log('  ' + k.padEnd(12) + '决策 ' + b.n + '  其中mx>12被现行门控挡掉的 ' + b.over12);
}
/* 采样几个 mx>12 且 total≤26 的真决策，单独测求解耗时 */
const samples = realDecidePts.filter(p => p.mx > 12 && p.total <= 26);
console.log('—— mx>12 且 total≤26 的真决策样本: ' + samples.length + ' 个 ——');
