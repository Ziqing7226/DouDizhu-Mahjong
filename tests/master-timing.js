/* 斗地主 —— 纯前端单机斗地主游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * master-timing.js —— 大师档决策耗时分布（验证 3 秒红线）
 * master@0 vs hard@1/2，固定种子，计时所有 master 座位决策。
 * 用法：node tests/master-timing.js [局数]
 * ========================================================================== */
'use strict';

const Cards = require('../js/cards.js');
const AI = require('../js/ai.js');

const N = Number(process.argv[2] || 10);
const SEED = 20260901;

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const origDecide = AI.decidePlay;
const times = [];
AI.decidePlay = function (ctx) {
  if (ctx.difficulty !== 'master') return origDecide(ctx);
  const t0 = Date.now();
  const r = origDecide(ctx);
  times.push(Date.now() - t0);
  return r;
};

let games = 0, wins0 = 0;
for (let i = 0; i < N; i++) {
  const deck = Cards.shuffle(Cards.makeDeck(), mulberry32(SEED + i * 7919));
  const hands = [deck.slice(0, 17), deck.slice(17, 34), deck.slice(34, 51)];
  const bottom = deck.slice(51);
  const landlord = i % 3;
  hands[landlord] = Cards.sortCards(hands[landlord].concat(bottom));
  const roles = [0, 1, 2].map(s => (s === landlord ? 'landlord' : 'farmer'));

  const played = [];
  let turn = landlord, lastCombo = null, lastSeat = null, passCount = 0, winner = -1;

  for (let guard = 0; guard < 800; guard++) {
    const seat = turn;
    const hand = hands[seat];
    const diff = seat === 0 ? 'master' : 'hard';
    const res = AI.decidePlay({
      difficulty: diff, hand, seat, role: roles[seat], landlordSeat: landlord,
      teammateSeat: roles[seat] === 'farmer'
        ? [0, 1, 2].find(s => s !== seat && roles[s] === 'farmer') : landlord,
      lastCombo: lastSeat === seat ? null : lastCombo, lastSeat,
      counts: hands.map(h => h.length), played,
      hands: diff === 'master' ? hands.map(h => h.slice()) : null
    });

    if (res && res.cards && res.cards.length) {
      const combo = Cards.parse(res.cards);
      if (!combo) break;
      if (lastCombo && !Cards.canBeat(combo, lastCombo)) break;
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
  if (winner >= 0) { games++; if (winner === 0) wins0++; }
}

times.sort((a, b) => a - b);
const avg = times.reduce((a, b) => a + b, 0) / Math.max(1, times.length);
const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))];
console.log(JSON.stringify({
  games, wins0, decisions: times.length,
  avgMs: +avg.toFixed(0), p95Ms: p95, maxMs: times[times.length - 1],
  over3s: times.filter(t => t > 3000).length
}));
