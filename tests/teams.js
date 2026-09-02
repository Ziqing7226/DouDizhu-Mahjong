/* 斗地主 —— 纯前端单机斗地主游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * teams.js —— 团队对抗测量（更贴近玩家真实体验）
 *
 * duel.js 的问题：农民的成败一半取决于队友，单个座位的强弱被稀释。
 * 这里固定「0 号位当地主、1/2 号位当农民」，分别测四种组合：
 *   ① 地主normal + 农民normal×2   （基准）
 *   ② 地主normal + 农民hard×2     （检验：hard 农民是否更强）
 *   ③ 地主hard   + 农民normal×2   （检验：hard 地主是否更强）
 *   ④ 地主hard   + 农民hard×2     （全 hard 局）
 * 固定牌局（种子化），可直接横向比较农民胜率 / 地主胜率。
 *
 * 用法： node tests/teams.js [局数] [种子]
 * ========================================================================== */
'use strict';

const Cards = require('../js/cards.js');
const Dec = require('../js/decompose.js');
const AI = require('../js/ai.js');

if (process.env.FEAT) {
  process.env.FEAT.split(',').forEach(function (kv) {
    var p = kv.split(':');
    if (p.length === 2 && AI.FEAT && p[0] in AI.FEAT) AI.FEAT[p[0]] = p[1] === '1';
  });
}
if (process.env.ENDGAME && AI.FEAT) AI.FEAT.endgameN = Number(process.env.ENDGAME);
if (process.env.POSITION && AI.FEAT) AI.FEAT.position = process.env.POSITION === '1';

const N = Number(process.argv[2] || 250);
const SEED = Number(process.argv[3] || 888888);

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** 0 号位是地主，1/2 号位是农民，难度由配置给定；返回农民是否获胜 */
function playGame(i, diffL, diffF) {
  const deck = Cards.shuffle(Cards.makeDeck(), mulberry32(SEED + i * 104729));
  const hands = [deck.slice(0, 17), deck.slice(17, 34), deck.slice(34, 51)];
  hands[0] = Cards.sortCards(hands[0].concat(deck.slice(51)));
  const roles = ['landlord', 'farmer', 'farmer'];

  const played = [];
  let turn = 0;
  let lastCombo = null, lastSeat = null, passCount = 0, winner = -1;

  for (let guard = 0; guard < 800; guard++) {
    const seat = turn;
    const hand = hands[seat];
    const teammateSeat = roles[seat] === 'farmer'
      ? [1, 2].find(s => s !== seat) : 0;

    const res = AI.decidePlay({
      difficulty: seat === 0 ? diffL : diffF,
      hand, seat, role: roles[seat], landlordSeat: 0, teammateSeat,
      lastCombo: lastSeat === seat ? null : lastCombo,
      lastSeat, counts: hands.map(h => h.length), played,
      hands: (seat === 0 ? diffL : diffF) === 'master' ? hands.map(h => h.slice()) : null
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
  return winner !== 0;   // 农民胜 = true
}

const CONFIGS = [
  { label: '①基准:  地主normal 农民normal', L: 'normal', F: 'normal' },
  { label: '②农民加强: 地主normal 农民hard', L: 'normal', F: 'hard' },
  { label: '③地主加强: 地主hard 农民normal', L: 'hard', F: 'normal' },
  { label: '④全hard:  地主hard 农民hard  ', L: 'hard', F: 'hard' }
];

const t0 = Date.now();
const out = [];
let pending = CONFIGS.length;

CONFIGS.forEach(function (cfg) {
  let farmerWins = 0, games = 0, skipped = 0;
  for (let i = 0; i < N; i++) {
    const r = playGame(i, cfg.L, cfg.F);
    if (r === null) { skipped++; continue; }
    games++;
    if (r) farmerWins++;
  }
  out.push({
    label: cfg.label,
    farmerWinRate: games ? farmerWins / games : 0,
    landlordWinRate: games ? 1 - farmerWins / games : 0,
    games: games, skipped: skipped
  });
  if (--pending === 0) report();
});

function report() {
  const base = out[0];
  console.log('=== 团队对抗测量（' + N + ' 局固定牌局，种子 ' + SEED + '）===');
  console.log('组合                              农民胜率    地主胜率    与基准差');
  out.forEach(function (r) {
    const pad = (v, n) => String(v).padStart(n);
    const d = (r.farmerWinRate - base.farmerWinRate) * 100;
    console.log('  ' + r.label + '   ' +
      pad((r.farmerWinRate * 100).toFixed(1) + '%', 8) + '    ' +
      pad((r.landlordWinRate * 100).toFixed(1) + '%', 8) + '    ' +
      pad((d >= 0 ? '+' : '') + d.toFixed(1) + 'pp', 8));
  });
  console.log('\n（②的农民胜率若明显高于①，说明 hard 农民确实更强；③同理检验地主）');
  console.log('耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
}
