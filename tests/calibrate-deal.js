/* 斗地主 —— 纯前端单机斗地主游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* calibrate-deal.js —— 校准发牌偏向量级（一次性诊断脚本，可复跑）
 * 统计各档 best-of-N 下玩家 17 张「好牌评分」的分布，
 * 用于设定 test-ui 中回归断言的阈值。
 * 评分函数与 js/game.js 的 handStrength 保持一致（口径变更需同步两处）。 */
'use strict';
const Cards = require('../js/cards.js');
const Dec = require('../js/decompose.js');

function handStrength(hand) {
  var cnt = {};
  for (var i = 0; i < hand.length; i++) {
    var r = hand[i].rank;
    cnt[r] = (cnt[r] || 0) + 1;
  }
  var score = 0;
  if (cnt[16]) score += 3;
  if (cnt[17]) score += 3.5;
  if (cnt[16] && cnt[17]) score += 4;
  score += (cnt[15] || 0) * 2;
  score += (cnt[14] || 0) * 1;
  for (var k in cnt) if (cnt[k] === 4 && +k <= 15) score += 5;
  score -= Dec.minHands(hand, 'quick') * 1.2;
  return score;
}

const N = 400;
const bestOf = { master: 1, hard: 3, easy: 6 };   // 期望口径（实际带 ±1 抖动）
function sample(n) {
  let best = -1e9;
  for (let t = 0; t < n; t++) {
    const deck = Cards.shuffle(Cards.makeDeck());
    best = Math.max(best, handStrength(deck.slice(0, 17)));
  }
  return best;
}

for (const [name, k] of Object.entries(bestOf)) {
  let sum = 0, min = 1e9, max = -1e9, below0 = 0;
  for (let i = 0; i < N; i++) {
    const s = sample(k);
    sum += s;
    if (s < min) min = s;
    if (s > max) max = s;
    if (s <= 0) below0++;   // 「差牌」占比（隐蔽性指标：新手档也不该把把好牌）
  }
  console.log(name.padEnd(7), 'K=' + k,
    'mean=' + (sum / N).toFixed(2),
    'min=' + min.toFixed(1), 'max=' + max.toFixed(1),
    '弱牌率=' + (below0 / N * 100).toFixed(0) + '%');
}
console.log('\n(弱牌率 = 评分 ≤ 0 的局占比；新手档保留部分弱牌，避免明显到被察觉)');
