/* 斗地主 —— 纯前端单机斗地主游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * duel.js —— 用固定牌局做「配对比较」的强度测量
 *
 * 为什么需要它：bench-ai.js 每次随机发牌，200 局的标准误约 ±0.1，
 * 而我们关心的强弱差异也就 0.1 量级 —— 根本分不清。
 * 这里用固定的一批牌局（种子化洗牌）跑所有配置，牌局质量带来的方差被抵消，
 * 剩下的才是真实的策略差异。
 *
 * 模式一（默认）决斗：0 号位用 A 难度，1/2 号位用 B 难度，地主轮换。
 *   指标 = 0 号位场均净积分 − (1、2 号位场均净积分)
 *   > 0 说明 A 确实强于 B。
 *
 * 用法：
 *   node tests/duel.js A B [局数] [种子]
 *   node tests/duel.js hard normal 300
 * ========================================================================== */
'use strict';

const Cards = require('../js/cards.js');
const Dec = require('../js/decompose.js');
const AI = require('../js/ai.js');

// A/B 开关：FEAT="forcedWin:1,rollout:0"
if (process.env.FEAT) {
  process.env.FEAT.split(',').forEach(function (kv) {
    var p = kv.split(':');
    if (p.length === 2 && AI.FEAT && p[0] in AI.FEAT) AI.FEAT[p[0]] = p[1] === '1';
  });
}
// 残局推演阈值：ENDGAME=n
if (process.env.ENDGAME && AI.FEAT) AI.FEAT.endgameN = Number(process.env.ENDGAME);
if (process.env.PASSBIAS && AI.FEAT) AI.FEAT.passBias = Number(process.env.PASSBIAS);
if (process.env.MUSTBLOCK && AI.FEAT) AI.FEAT.mustBlock = process.env.MUSTBLOCK === '1';
if (process.env.SAFEBONUS && AI.FEAT) AI.FEAT.safeBonus = process.env.SAFEBONUS === '1';
if (process.env.HOLDSLEAD && AI.FEAT) AI.FEAT.holdsLead = process.env.HOLDSLEAD === '1';
if (process.env.ESCAPEBLOCK && AI.FEAT) AI.FEAT.escapeBlock = process.env.ESCAPEBLOCK === '1';
if (process.env.POSITION && AI.FEAT) AI.FEAT.position = process.env.POSITION === '1';
if (process.env.ROLLK && AI.FEAT) AI.FEAT.rolloutK = Number(process.env.ROLLK);
// 大师档是完全信息 AI：测试时通过 ctx.hands 传入真实手牌
// 难度参数也可覆盖（只影响被测方；这里同时作用于 A 与 B，故仅在同档对比时使用）
if (process.env.BOMBPEN) { AI.CFG.hard.bombPenalty = Number(process.env.BOMBPEN); }
if (process.env.LEADBOMB) { AI.CFG.hard.leadBombPenalty = Number(process.env.LEADBOMB); }

const A = process.argv[2] || 'hard';
const B = process.argv[3] || 'normal';
const N = Number(process.argv[4] || 300);
const SEED = Number(process.argv[5] || 20260830);

/** 确定性 PRNG，保证同一局号在所有配置下发到完全相同的牌 */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const origInEndgame = AI.FEAT ? null : null;

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
      difficulty: seat === 0 ? A : B,
      hand, seat, role: roles[seat], landlordSeat: landlord, teammateSeat,
      lastCombo: lastSeat === seat ? null : lastCombo,
      lastSeat, counts: hands.map(h => h.length), played,
      hands: (seat === 0 ? A : B) === 'master' ? hands.map(h => h.slice()) : null
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
  if (winner < 0) return null;

  const delta = [0, 0, 0];
  for (let s = 0; s < 3; s++) {
    const isL = (s === landlord);
    const win = (s === winner) || (isL && winner === landlord) || (!isL && winner !== landlord);
    delta[s] = isL ? (win ? 2 : -2) : (win ? 1 : -1);
  }
  return delta;
}

const t0 = Date.now();
let sumA = 0, sumB = 0, done = 0, skipped = 0;
const perGame = [];
for (let i = 0; i < N; i++) {
  const d = playGame(i);
  if (!d) { skipped++; continue; }
  done++;
  sumA += d[0];
  sumB += (d[1] + d[2]) / 2;
  perGame.push(d[0] - (d[1] + d[2]) / 2);
}

const avgA = sumA / Math.max(1, done);
const avgB = sumB / Math.max(1, done);
const diff = avgA - avgB;
// 配对差值的标准误
const mean = perGame.reduce((a, b) => a + b, 0) / Math.max(1, perGame.length);
const varr = perGame.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, perGame.length);
const sem = Math.sqrt(varr / Math.max(1, perGame.length));

console.log(JSON.stringify({
  A: A, B: B, games: done, skipped: skipped,
  avgA: +avgA.toFixed(3), avgB: +avgB.toFixed(3),
  diff: +diff.toFixed(3), sem: +sem.toFixed(3),
  t: +(diff / Math.max(1e-9, sem)).toFixed(2),
  seconds: +((Date.now() - t0) / 1000).toFixed(1)
}));
