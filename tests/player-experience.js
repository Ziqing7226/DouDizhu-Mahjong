/* 斗地主 —— 纯前端单机斗地主游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * player-experience.js —— 玩家视角的房间胜率测量
 *
 * 与 duel.js 的分工：duel 用配对法隔离「纯 AI 强度差」，刻意抹平发牌；
 * 但真实玩家的体验里，发牌规则本身就是房间差异的一部分——
 *   新手场 best-of-5~7 偏向玩家好牌、高手场 best-of-2~3 轻偏、
 *   大师场纯随机（game.js riggedDeck），且叫分行为随发牌质量变化。
 * 本工具完整复刻真实对局链路：房间发牌偏向 → 叫分抢地主（三家不叫
 * 重发）→ 出牌至终局，统计「我」（normal 档代打）在三个房间的胜率。
 *
 *   node tests/player-experience.js [每房间局数=300] [种子]
 *   ROOMS=easy,hard,master 可选房间子集
 *
 * 口径：
 *   我方 = 0 号位，难度恒为 normal（代打，不随房间变）；
 *   对手 = 1/2 号位，均为房间难度（大师场对手持完全信息）；
 *   胜率 = 我方阵营获胜的局数 / 有效局数（三家不叫的重发不计入）；
 *   积分 = 底分口径 ±2/±1（不计叫分/加倍/炸弹倍数——胜率不受影响）。
 * ========================================================================== */
'use strict';

const Cards = require('../js/cards.js');
const Dec = require('../js/decompose.js');
const AI = require('../js/ai.js');

const ROOMS = (process.env.ROOMS || 'easy,hard,master').split(',');
const N = Number(process.argv[2] || 300);
const SEED = Number(process.argv[3] || 20260906);
const MY_DIFF = 'normal';

/* 全局 Math.random 换成种子流：整场运行完全可复现
 *（叫分噪声 / 新手随机 / 洗牌兜底都从同一条流取数） */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    const t = Math.imul(a ^ a >>> 15, 1 | a);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const stream = mulberry32(SEED);
Math.random = function () { return stream(); };

/* ---------------- 发牌偏向（逐行镜像 game.js，保持口径一致） ---------------- */

function handStrength(hand) {
  const cnt = {};
  for (let i = 0; i < hand.length; i++) {
    const r = hand[i].rank;
    cnt[r] = (cnt[r] || 0) + 1;
  }
  let score = 0;
  if (cnt[16]) score += 3;
  if (cnt[17]) score += 3.5;
  if (cnt[16] && cnt[17]) score += 4;
  score += (cnt[15] || 0) * 2;
  score += (cnt[14] || 0) * 1;
  for (const k in cnt) if (cnt[k] === 4 && +k <= 15) score += 5;
  score -= Dec.minHands(hand, 'quick') * 1.2;
  return score;
}

function riggedDeck(difficulty) {
  const n = difficulty === 'easy' ? 5 + ((Math.random() * 3) | 0)
    : difficulty === 'hard' ? 3
      : 1;
  if (n <= 1) return Cards.shuffle(Cards.makeDeck());
  let best = null, bestScore = -1e9;
  for (let t = 0; t < n; t++) {
    const deck = Cards.shuffle(Cards.makeDeck());
    const s = handStrength(deck.slice(0, 17));
    if (s > bestScore) { bestScore = s; best = deck; }
  }
  return best;
}

/* ---------------- 叫分（各座位按自己难度决策） ---------------- */

function bidLandlord(hands, room) {
  const first = (Math.random() * 3) | 0;
  const order = [first, (first + 1) % 3, (first + 2) % 3];
  let max = 0, maxSeat = -1;
  for (const s of order) {
    const v = AI.decideBid(hands[s], {
      difficulty: s === 0 ? MY_DIFF : room,
      maxBidSoFar: max
    });
    const bid = Math.min(3, Math.max(0, v));
    if (bid > max) { max = bid; maxSeat = s; }
    if (max === 3) break;   // 叫 3 分立即锁定
  }
  return maxSeat;
}

/* ---------------- 出牌至终局（与 duel.js 同构） ---------------- */

function playOut(hands, landlord, room) {
  const roles = [0, 1, 2].map(s => (s === landlord ? 'landlord' : 'farmer'));
  const played = [];
  let turn = landlord, lastCombo = null, lastSeat = null, passCount = 0, winner = -1;

  for (let guard = 0; guard < 800; guard++) {
    const seat = turn;
    const hand = hands[seat];
    const teammateSeat = roles[seat] === 'farmer'
      ? [0, 1, 2].find(s => s !== seat && roles[s] === 'farmer') : landlord;
    const diff = seat === 0 ? MY_DIFF : room;

    const res = AI.decidePlay({
      difficulty: diff, hand, seat, role: roles[seat],
      landlordSeat: landlord, teammateSeat,
      lastCombo: lastSeat === seat ? null : lastCombo,
      lastSeat, counts: hands.map(h => h.length), played,
      hands: diff === 'master' ? hands.map(h => h.slice()) : null
    });

    if (res && res.cards && res.cards.length) {
      const combo = Cards.parse(res.cards);
      if (!combo) return { err: '非法牌型 seat=' + seat };
      if (lastCombo && !Cards.canBeat(combo, lastCombo)) return { err: '压不过上家 seat=' + seat };
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
  if (winner < 0) return { err: '800 步未终局' };
  return { winner };
}

/* ---------------- 主循环 ---------------- */

console.log(`玩家视角房间胜率测量：我方 ${MY_DIFF} 档代打，每房间 ${N} 局，种子 ${SEED}`);
console.log('（发牌偏向 / 叫分重发 / 大师完全信息均按真实游戏规则）');
console.log('='.repeat(72));

for (const room of ROOMS) {
  const stats = { done: 0, wins: 0, asLandlord: 0, landlordWins: 0, farmerWins: 0,
    redeals: 0, score: 0, strengthSum: 0, errs: [] };

  while (stats.done < N) {
    const deck = riggedDeck(room);
    const hands = [
      Cards.sortCards(deck.slice(0, 17)),
      Cards.sortCards(deck.slice(17, 34)),
      Cards.sortCards(deck.slice(34, 51))
    ];
    stats.strengthSum += handStrength(deck.slice(0, 17));

    const landlord = bidLandlord(hands, room);
    if (landlord < 0) { stats.redeals++; continue; }   // 三家不叫 → 重发，不计入

    const r = playOut(hands, landlord, room);
    if (r.err) { stats.errs.push(r.err); continue; }

    stats.done++;
    const iAmLandlord = landlord === 0;
    if (iAmLandlord) stats.asLandlord++;
    const landlordSideWon = r.winner === landlord;
    const iWin = iAmLandlord ? landlordSideWon : !landlordSideWon;
    if (iWin) stats.wins++;
    if (iAmLandlord && landlordSideWon) stats.landlordWins++;
    if (!iAmLandlord && !landlordSideWon) stats.farmerWins++;
    stats.score += iAmLandlord ? (iWin ? 2 : -2) : (iWin ? 1 : -1);
  }

  const wr = (stats.wins / stats.done * 100).toFixed(1);
  const lShare = (stats.asLandlord / stats.done * 100).toFixed(1);
  const lwr = stats.asLandlord ? (stats.landlordWins / stats.asLandlord * 100).toFixed(1) : '—';
  const fwr = (stats.done - stats.asLandlord)
    ? (stats.farmerWins / (stats.done - stats.asLandlord) * 100).toFixed(1) : '—';
  console.log(`【${room} 场】有效 ${stats.done} 局（重发 ${stats.redeals} 次，异常 ${stats.errs.length}）`);
  console.log(`  我方胜率 ${wr}%   场均积分 ${(stats.score / stats.done).toFixed(2)}`);
  console.log(`  当地主占比 ${lShare}%（地主胜率 ${lwr}% / 农民胜率 ${fwr}%）`);
  console.log(`  我方起手 17 张强度均值 ${(stats.strengthSum / (stats.done + stats.redeals)).toFixed(2)}` +
    '（标定参考：easy +2.66 / hard +0.52 / master −2.70）');
  if (stats.errs.length) console.log('  异常样本: ' + stats.errs.slice(0, 3).join(' / '));
  console.log('');
}
