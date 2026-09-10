/* 诊断脚本（第五轮）：抢挡——队友领牌被短地主截走即送胜
 * 用户原型：记牌/透视得知地主只剩一张 K；队友出 6；场上只有我有比 K 大的牌
 * → 我必须出（用 A/2 接走），否则地主 K 接走 6 直接获胜
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
function build(difficulty, hands, aiSeat, landlordSeat, lastComboRanks, lastSeat) {
  usedGlobal = {};
  var hs = hands.map(take);
  var onTable = new Set();
  hs.forEach(function (h) { h.forEach(function (c) { onTable.add(c.id); }); });
  var played = Cards.makeDeck().filter(function (c) { return !onTable.has(c.id); });
  return {
    difficulty: difficulty, hand: hs[aiSeat], seat: aiSeat,
    role: aiSeat === landlordSeat ? 'landlord' : 'farmer',
    landlordSeat: landlordSeat,
    teammateSeat: aiSeat === landlordSeat ? -1 : (3 - aiSeat - landlordSeat + 3) % 3,
    lastCombo: Cards.parse(comboCards(lastComboRanks)), lastSeat: lastSeat,
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

console.log('=== 用例 1（用户原型）：地主(座位0)报单K，队友(座位1)领6，AI(座位2)握 A/2/双王 ===');
console.log('  正确：出 A 抢挡（地主压不起 → 先手留在农民）；错误：放行 → 地主 K 接走报胜');
[[2, 'hard'], [2, 'master']].forEach(function (p) {
  var ctx = build(p[1],
    [[13],                                   // 地主：只剩 K
     [6, 3, 4, 8, 9, 10, 11, 12],            // 领牌队友：8 张杂牌
     [14, 15, 16, 17, 5, 9]],                // AI：A 2 双王 + 5 9（比 K 大的牌全在我手）
    p[0], 0, [6], 1);
  var res = AI.decidePlay(ctx);
  report('抢挡报单', ctx, res, res ? '  （抢挡 ✓）' : '  ←⚠ 放行 → 地主 K 接走报胜！');
});

console.log('\n=== 用例 2：地主报双 [K,Q]，队友领 6，AI 握 A/双王 ===');
[[2, 'hard'], [2, 'master']].forEach(function (p) {
  var ctx = build(p[1],
    [[13, 12],
     [6, 3, 4, 8, 9, 10, 11],
     [14, 16, 17, 5, 9, 7]],
    p[0], 0, [6], 1);
  var res = AI.decidePlay(ctx);
  report('抢挡报双', ctx, res, res ? '  （抢挡 ✓）' : '  ←⚠ 放行 → 地主接走后下一手领出即胜！');
});

console.log('\n=== 用例 3（控制）：地主报单但只剩一张 4（压不过 6）→ 应放行让队友继续 ===');
[[2, 'hard'], [2, 'master']].forEach(function (p) {
  var ctx = build(p[1],
    [[4],
     [6, 3, 8, 9, 10, 11, 12],
     [14, 15, 16, 17, 5, 9]],
    p[0], 0, [6], 1);
  var res = AI.decidePlay(ctx);
  report('无险放行', ctx, res, res ? (ctx.difficulty === 'master' ? '  ←⚠ 透视明知无险还压队友' : '  （保守抢挡，信息边界内正确）') : '  （放行 ✓）');
});

console.log('\n=== 用例 4（控制）：地主 6 张牌（不构成即胜威胁）→ 应放行 ===');
[[2, 'hard'], [2, 'master']].forEach(function (p) {
  var ctx = build(p[1],
    [[13, 12, 11, 10, 9, 8],
     [6, 3, 4, 7, 5, 10, 11],
     [14, 15, 16, 17, 5, 9]],
    p[0], 0, [6], 1);
  var res = AI.decidePlay(ctx);
  report('远敌放行', ctx, res, res ? '  ←⚠ 不必压队友' : '  （放行 ✓）');
});

console.log('\n=== 用例 5（控制·座位）：地主在我上游且已放行（lastCombo 仍是队友的 6）→ 安全放行 ===');
[[1, 'hard'], [1, 'master']].forEach(function (p) {
  // 座位：0 地主 → 1 AI → 2 队友。队友(2)领 6，地主(0)已过，轮到 AI(1)
  var ctx = build(p[1],
    [[13],
     [14, 15, 16, 17, 5, 9],
     [6, 3, 4, 8, 9, 10, 11, 12]],
    p[0], 0, [6], 2);
  var res = AI.decidePlay(ctx);
  report('上游已过', ctx, res, res ? '  ←⚠ 地主已放行，无需抢挡' : '  （放行 ✓）');
});
