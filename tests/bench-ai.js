/* 斗地主 —— 纯前端单机斗地主游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * bench-ai.js —— AI 三档强度的量化基线
 *
 * 三人局里没法直接做「一对一胜负」，所以用**净积分**作为强度指标：
 *   地主赢 +2 / 输 -2，农民赢 +1 / 输 -1
 * 每局轮换难度与座位的对应关系，保证三档在「座位」和「地主/农民」上机会均等。
 * 若某档明显更强，其累计净积分会显著高于其他档。
 *
 * 运行： node tests/bench-ai.js [局数]
 * ========================================================================== */
'use strict';

const Cards = require('../js/cards.js');
const Dec = require('../js/decompose.js');
const AI = require('../js/ai.js');

// A/B 开关：FEAT="forcedWin:1,escapeBlock:0" 形式覆盖 ai.js 的特性开关
if (process.env.FEAT) {
  process.env.FEAT.split(',').forEach(function (kv) {
    var p = kv.split(':');
    if (p.length === 2 && AI.FEAT && p[0] in AI.FEAT) AI.FEAT[p[0]] = p[1] === '1';
  });
}

const N = Number(process.argv[2] || 120);
const DIFFS = ['easy', 'normal', 'hard'];

const stat = {};
for (const d of DIFFS) {
  stat[d] = { score: 0, games: 0, landlord: 0, landlordWin: 0, farmer: 0, farmerWin: 0 };
}

/** 用固定的牌堆复刻一局，返回各座位净积分 */
function playGame(i) {
  const deck = Cards.shuffle(Cards.makeDeck());
  const hands = [deck.slice(0, 17), deck.slice(17, 34), deck.slice(34, 51)];
  const bottom = deck.slice(51);

  // 地主轮换用 i%3，难度轮换用 floor(i/3)%3，两者解耦，避免相关性
  const landlord = i % 3;
  const offset = Math.floor(i / 3) % 3;
  const diffOf = (seat) => DIFFS[(seat + offset) % 3];

  hands[landlord] = Cards.sortCards(hands[landlord].concat(bottom));
  const roles = [0, 1, 2].map(s => (s === landlord ? 'landlord' : 'farmer'));

  const played = [];
  let turn = landlord;
  let lastCombo = null, lastSeat = null, passCount = 0;
  let winner = -1;

  for (let guard = 0; guard < 800; guard++) {
    const seat = turn;
    const hand = hands[seat];
    const teammateSeat = roles[seat] === 'farmer'
      ? [0, 1, 2].find(s => s !== seat && roles[s] === 'farmer')
      : landlord;

    const res = AI.decidePlay({
      difficulty: diffOf(seat),
      hand, seat, role: roles[seat], landlordSeat: landlord, teammateSeat,
      lastCombo: lastSeat === seat ? null : lastCombo,
      lastSeat, counts: hands.map(h => h.length), played,
      hands: (diffOf(seat) === 'master') ? hands.map(h => h.slice()) : null
    });

    if (res && res.cards && res.cards.length) {
      const combo = Cards.parse(res.cards);
      if (!combo) return null;
      if (lastCombo && !Cards.canBeat(combo, lastCombo)) return null;
      const ids = new Set(res.cards.map(c => c.id));
      hands[seat] = hand.filter(c => !ids.has(c.id));
      played.push(...res.cards);
      lastCombo = combo; lastSeat = seat; passCount = 0;
      if (hands[seat].length === 0) { winner = seat; break; }
    } else {
      passCount++;
      if (lastCombo && passCount >= 2) { lastCombo = null; passCount = 0; }
    }
    turn = (turn + 1) % 3;
  }
  if (winner < 0) return null;

  const delta = {};
  for (let s = 0; s < 3; s++) {
    const d = diffOf(s);
    const isLandlord = (s === landlord);
    const win = (s === winner) || (isLandlord && winner === landlord) ||
      (!isLandlord && winner !== landlord);
    const v = isLandlord ? (win ? 2 : -2) : (win ? 1 : -1);
    delta[d] = (delta[d] || 0) + v;
    stat[d].games++;
    if (isLandlord) { stat[d].landlord++; if (win) stat[d].landlordWin++; }
    else { stat[d].farmer++; if (win) stat[d].farmerWin++; }
  }
  return delta;
}

const t0 = Date.now();
let done = 0, skipped = 0;
for (let i = 0; i < N; i++) {
  const d = playGame(i);
  if (!d) { skipped++; continue; }
  done++;
  for (const k in d) stat[k].score += d[k];
}
const dt = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`\n=== AI 强度基线（${done} 局，耗时 ${dt}s，跳过 ${skipped}）===`);
console.log('档位    净积分   场均     场次   地主胜率      农民胜率');
for (const d of DIFFS) {
  const s = stat[d];
  const per = (s.score / Math.max(1, done)).toFixed(3);
  const lw = s.landlord ? (s.landlordWin / s.landlord * 100).toFixed(1) : '--';
  const fw = s.farmer ? (s.farmerWin / s.farmer * 100).toFixed(1) : '--';
  console.log(
    `${d.padEnd(7)} ${String(s.score).padStart(6)}  ${per.padStart(6)}  ` +
    `${String(s.games).padStart(5)}   ${String(lw).padStart(6)}%      ${String(fw).padStart(6)}%`
  );
}

const scores = DIFFS.map(d => stat[d].score);
const gap = Math.max(...scores) - Math.min(...scores);
console.log(`\n三档净积分极差: ${gap}（越大说明难度区分度越明显）`);
console.log(`困难 - 简单 = ${stat.hard.score - stat.easy.score}`);
