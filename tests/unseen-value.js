/* 斗地主 —— 纯前端单机斗地主游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * unseen-value.js —— 量化「信息推断」对 AI 强度的真实增量（两个锚点）
 *
 * 背景：中盘对手建模本质是 unseen 使用的精化。按「先算账再动手」原则，
 * 精化的收益上限不可能超过「unseen 从无到有」的价值本身。本脚本测量：
 *   锚点 A：normal(开 unseen) @0 vs normal @1/2 —— 推断整套的真实增量
 *   锚点 B：master @0 vs normal @1/2     —— 完全信息（推断绝对上限）
 *
 * 单侧门控：CFG 只在 0 号位决策时临时翻转，1/2 号位保持原样。
 *
 * 用法：node tests/unseen-value.js [局数]
 * ========================================================================== */
'use strict';

const Cards = require('../js/cards.js');
const Dec = require('../js/decompose.js');
const AI = require('../js/ai.js');

const N = Number(process.argv[2] || 300);
const SEED = 20260830;

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** 0 号位决策时临时开启 useUnseen（单侧门控，1/2 号位不受影响） */
const origDecide = AI.decidePlay;
function patchFor(mode) {
  if (mode !== 'unseen') return origDecide;
  return function (ctx) {
    if (ctx.seat !== 0) return origDecide(ctx);
    AI.CFG.normal.useUnseen = true;
    try { return origDecide(ctx); }
    finally { AI.CFG.normal.useUnseen = false; }
  };
}

function playGame(i, aDiff, decideFn) {
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
    const diff = seat === 0 ? aDiff : 'normal';

    const res = decideFn({
      difficulty: diff,
      hand, seat, role: roles[seat], landlordSeat: landlord, teammateSeat,
      lastCombo: lastSeat === seat ? null : lastCombo,
      lastSeat, counts: hands.map(h => h.length), played,
      hands: (AI.CFG[diff] && AI.CFG[diff].perfectInfo) ? hands.map(h => h.slice()) : null
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

function run(aDiff, decideFn, label) {
  const t0 = Date.now();
  const per = [];
  let done = 0, skipped = 0;
  for (let i = 0; i < N; i++) {
    const w = playGame(i, aDiff, decideFn);
    // 注意：winner 可能为 0（0 号位获胜，falsy），只能用显式比较剔除 null/-1
    if (w === null || w < 0) { skipped++; continue; }
    done++;
    // 净积分：0 号位阵营 = 地主时 ±2 / 农民时 ±1（与 duel.js 一致）
    const landlord = i % 3;
    const win0 = (landlord === 0) ? (w === 0) : (w !== 0);
    per.push((landlord === 0 ? 2 : 1) * (win0 ? 1 : -1));
  }
  const mean = per.reduce((a, b) => a + b, 0) / Math.max(1, per.length);
  const varr = per.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, per.length);
  const sem = Math.sqrt(varr / Math.max(1, per.length));
  const wins = per.filter(x => x > 0).length;
  console.log(JSON.stringify({
    label, games: done, skipped,
    winRate0: +(100 * wins / Math.max(1, done)).toFixed(1) + '%',
    avg0: +mean.toFixed(3), sem: +sem.toFixed(3),
    t: +(mean / Math.max(1e-9, sem)).toFixed(2),
    seconds: +((Date.now() - t0) / 1000).toFixed(1)
  }));
}

// 自检：normal vs normal 双方都不动 —— diff 应 ≈ 0
const origPlain = AI.decidePlay;
run('normal', origPlain, 'A0 自检 normal(normal) vs normal —— 期望 diff≈0');
run('normal', patchFor('unseen'), 'A1 锚点A normal+unseen@0 vs normal —— 推断整套增量');
run('master', patchFor('master'), 'B  锚点B master@0 vs normal —— 完全信息上限');
