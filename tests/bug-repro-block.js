/* 诊断脚本（第三轮）：中盘积极拦截 / 卡地主
 * 现状：敌人领出逃牌（小单/小对）时，threat 中盘只有 2~6，
 * AI 几乎总是放行 —— 地主白得先手一张张顺走逃牌，农民毫无作为。
 * 期望：
 *   大师（透视）：知道地主压不回的压牌 → 必卡（+9）
 *   高手（记牌）：廉价压牌（非炸、不破结构、不动2/王）→ 主动顶（+6）
 *   控制：队友领出仍不压；破结构/动2的拦截仍不鼓励
 */
'use strict';
var Cards = require('../js/cards.js');
var AI = require('../js/ai.js');

var usedGlobal = {};
function take(ranks) {
  return ranks.map(function (r) {
    usedGlobal[r] = usedGlobal[r] || 0;
    if (usedGlobal[r] >= (r >= 16 ? 1 : 4)) throw new Error('点数 ' + r + ' 超张');
    var id = r >= 16 ? (r === 16 ? 52 : 53) : (r - 3) * 4 + usedGlobal[r]++;
    return Cards.makeCard(id);
  });
}
function comboCards(ranks) {
  return ranks.map(function (r) { return Cards.makeCard((r - 3) * 4 + 3); });
}
function build(difficulty, hands, aiSeat, role, landlordSeat, lastComboRanks, lastSeat) {
  usedGlobal = {};
  var hs = hands.map(take);
  var onTable = new Set();
  hs.forEach(function (h) { h.forEach(function (c) { onTable.add(c.id); }); });
  var played = Cards.makeDeck().filter(function (c) { return !onTable.has(c.id); });
  var lastCombo = lastComboRanks ? Cards.parse(comboCards(lastComboRanks)) : null;
  return {
    difficulty: difficulty, hand: hs[aiSeat], seat: aiSeat, role: role,
    landlordSeat: landlordSeat,
    teammateSeat: role === 'farmer' ? (3 - aiSeat - landlordSeat + 3) % 3 : -1,
    lastCombo: lastCombo, lastSeat: lastCombo ? lastSeat : -1,
    counts: hs.map(function (h) { return h.length; }),
    played: played,
    hands: difficulty === 'master' ? hs.map(function (h) { return h.slice(); }) : null
  };
}
function report(name, ctx, res, verdict) {
  var led = res && res.cards ? res.cards.map(function (c) { return c.rank; })
    .sort(function (a, b) { return a - b; }).join(',') : '(不要)';
  console.log('[' + name + '/' + ctx.difficulty + '] ' + (ctx.lastCombo ? '跟牌' : '领出') +
    ' → ' + led + '  tag=' + ((res && res.tag) || 'pass') + verdict);
}

console.log('=== 用例 1：地主领小单 5 逃牌，大师农民手握 J/Q（地主剩牌全 ≤10，透视可知压不回）===');
[[1, 'hard'], [1, 'master']].forEach(function (p) {
  var ctx = build(p[1],
    [[4, 4, 5, 6, 6, 7, 7, 8, 9, 9, 10, 10],          // 地主 12 张全小牌（已领出 5 之前的牌面）
     [11, 12, 13, 3, 4, 5, 6, 7, 8, 14, 15, 16, 17],   // 农民（无长顺，restAll>2）
     [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]],
    p[0], 'farmer', 0, [5], 0);
  report('卡地主逃单', ctx, AI.decidePlay(ctx),
    '  ← 期望压住（大师必卡，高手也应顶）');
});

console.log('\n=== 用例 2：地主领小对 44 逃牌，农民手握 99（结构无损）===');
[[1, 'hard'], [1, 'master']].forEach(function (p) {
  var ctx = build(p[1],
    [[3, 3, 4, 4, 5, 6, 7, 8, 9, 10, 11, 12],
     [9, 9, 3, 4, 5, 6, 7, 8, 13, 14, 15, 16, 17],
     [3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17]],
    p[0], 'farmer', 0, [4, 4], 0);
  report('卡地主逃对', ctx, AI.decidePlay(ctx), '  ← 期望压住');
});

console.log('\n=== 用例 3（控制）：队友农民领单 5，AI 不应压队友 ===');
[[1, 'hard'], [1, 'master']].forEach(function (p) {
  var ctx = build(p[1],
    [[4, 4, 5, 6, 6, 7, 7, 8, 9, 9, 10, 10],
     [11, 12, 13, 3, 4, 5, 6, 7, 8, 14, 15, 16, 17],
     [3, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]],
    p[0], 'farmer', 0, [5], 2);
  report('不压队友', ctx, AI.decidePlay(ctx), '  ← 期望放行');
});

console.log('\n=== 用例 4（控制）：拦截需拆顺子（破结构）或动用 2/王 —— 不应鼓励 ===');
[[1, 'hard'], [1, 'master']].forEach(function (p) {
  // 农民手牌：J 在顺子 JQKA2 里？顺子只到 A。改用 10 嵌在 10JQKA 顺子中，
  // 压地主单 5 只能拆顺（structLoss≥1）或用 2（main=15 不给加成）
  var ctx = build(p[1],
    [[4, 4, 5, 6, 6, 7, 7, 8, 9, 9, 10, 10],
     [10, 11, 12, 13, 14, 3, 3, 4, 5, 6, 7, 15, 16],
     [3, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 17]],
    p[0], 'farmer', 0, [5], 0);
  report('破结构不鼓励', ctx, AI.decidePlay(ctx), '  ← 期望不强拦（可放行）');
});
