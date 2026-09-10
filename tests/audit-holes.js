/* 审计探针（第四轮）：高手/大师出牌逻辑残余漏洞嫌疑点
 * P1 两手分支·对子版：AI=44+77，敌人剩 55/66 两对 → 应先出 77
 * P2 报单已知小牌（master 透视）：敌人最后一张是 4 → 领 5 不罚、领 3 该罚
 * P3 五张牌·炸弹逃逸（复核：数学无解——敌人 4444 可压任何领出后剩 K 报胜，防不住，非漏洞，仅记录行为）
 * P4 五张牌·三张逃逸：敌人剩 [10,10,999]，领小对 55 → 10,10 压后 999 报胜（漏洞嫌疑）
 * P5 控制：敌人 6 张（无速胜结构）时小单正常出，不应被误罚
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
function build(difficulty, hands, aiSeat, role, landlordSeat) {
  usedGlobal = {};
  var hs = hands.map(take);
  var onTable = new Set();
  hs.forEach(function (h) { h.forEach(function (c) { onTable.add(c.id); }); });
  var played = Cards.makeDeck().filter(function (c) { return !onTable.has(c.id); });
  return {
    difficulty: difficulty, hand: hs[aiSeat], seat: aiSeat, role: role,
    landlordSeat: landlordSeat,
    teammateSeat: role === 'farmer' ? (3 - aiSeat - landlordSeat + 3) % 3 : -1,
    lastCombo: null, lastSeat: -1,
    counts: hs.map(function (h) { return h.length; }),
    played: played,
    hands: difficulty === 'master' ? hs.map(function (h) { return h.slice(); }) : null
  };
}
function report(name, ctx, res, verdict) {
  var led = res && res.cards ? res.cards.map(function (c) { return c.rank; })
    .sort(function (a, b) { return a - b; }).join(',') : '(不要)';
  console.log('[' + name + '/' + ctx.difficulty + '] 领出 → ' + led +
    '  tag=' + ((res && res.tag) || 'pass') + verdict);
}

console.log('=== P1 两手·对子版：AI 地主 = 44+77，农民剩 55/66 ===');
[[0, 'hard'], [0, 'master']].forEach(function (p) {
  var ctx = build(p[1],
    [[4, 4, 7, 7], [5, 5, 6, 6], [3, 3, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]],
    p[0], 'landlord', 0);
  report('P1', ctx, AI.decidePlay(ctx),
    function () { return ''; } ? '' : '');
});

console.log('\n=== P2 报单已知小牌（透视）：农民最后一张是 4，地主领 3 会送、领 5 安全 ===');
[[0, 'hard'], [0, 'master']].forEach(function (p) {
  var ctx = build(p[1],
    [[3, 5, 8, 10, 10, 13, 13], [4], [3, 3, 5, 6, 6, 7, 7, 8, 9, 9, 11, 11, 12, 12, 14, 15]],
    p[0], 'landlord', 0);
  var res = AI.decidePlay(ctx);
  report('P2', ctx, res, res && res.combo.type === Cards.CT.SINGLE && res.combo.main === 3
    ? '  ←⚠ 领 3 被农民 4 压住报胜！' : '  （安全）');
});

console.log('\n=== P3 五张牌·炸弹逃逸：农民剩 [K,4,4,4,4]，地主领小单即送（K 压后 4444 报胜）===');
[[0, 'hard'], [0, 'master']].forEach(function (p) {
  var ctx = build(p[1],
    [[3, 5, 8, 8, 14, 15], [13, 4, 4, 4, 4],
     [3, 3, 5, 5, 6, 6, 7, 7, 9, 9, 10, 10, 11, 11]],
    p[0], 'landlord', 0);
  var res = AI.decidePlay(ctx);
  var bad = res && res.combo.type === Cards.CT.SINGLE && res.combo.main < 13;
  report('P3', ctx, res, bad ? '  （无解牌型：炸弹可压任何领出，行为记录）' : '  （安全）');
});

console.log('\n=== P4 五张牌·三张/三带一逃逸：农民剩 [10,10,9,9,9]，领小单/小对即送 ===');
[[0, 'hard'], [0, 'master']].forEach(function (p) {
  var ctx = build(p[1],
    [[3, 5, 5, 8, 14, 15], [10, 10, 9, 9, 9],
     [3, 3, 4, 4, 5, 6, 6, 7, 7, 8, 11, 11, 12, 12]],
    p[0], 'landlord', 0);
  var res = AI.decidePlay(ctx);
  var bad = res && ((res.combo.type === Cards.CT.SINGLE && res.combo.main < 13) ||
    (res.combo.type === Cards.CT.PAIR && res.combo.main < 9));
  report('P4', ctx, res, bad ? '  （无解牌型，行为记录）' : '  （安全）');
});

console.log('\n=== P5 控制：农民剩 6 张散牌（无速胜结构），小单应正常出，不被误罚 ===');
[[0, 'hard'], [0, 'master']].forEach(function (p) {
  var ctx = build(p[1],
    [[3, 5, 8, 8, 14, 15], [3, 5, 7, 10, 12, 14],
     [3, 3, 4, 4, 5, 6, 6, 7, 7, 9, 9, 10, 11, 11, 12, 12]],
    p[0], 'landlord', 0);
  var res = AI.decidePlay(ctx);
  report('P5', ctx, res, res && res.combo.main <= 5 ? '  （小牌正常出 ✓ 未误罚）' : '  （偏保守但可接受）');
});

console.log('\n=== P6 对称性：地主 AI 面对农民逃牌小单 5，也应积极拦截 ===');
[[0, 'hard'], [0, 'master']].forEach(function (p) {
  // 地主 AI 手握 J（农民压不回——农民手牌全 ≤10），农民 1 领单 5 逃牌
  var ctx = build(p[1],
    [[11, 12, 13, 3, 4, 5, 6, 7, 8, 14, 15, 16, 17],
     [3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 11, 12, 13, 14, 15],
     [3, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]],
    p[0], 'landlord', 0);
  ctx.lastCombo = Cards.parse([Cards.makeCard((5 - 3) * 4 + 3)]);
  ctx.lastSeat = 1;
  var res = AI.decidePlay(ctx);
  report('P6', ctx, res, res ? '  （拦截 ✓）' : '  ←⚠ 放行逃牌');
});

console.log('\n=== P7 必胜链·最后一手误判：AI=[3,A,2]，农民=[10,10,9,9,9] ===');
console.log('  正确顺序 A→2→3（3 作为最后一手打出即胜，无需是绝张）；领 3 先行 = 被 10 压后三带一报胜');
[[0, 'hard'], [0, 'master']].forEach(function (p) {
  var ctx = build(p[1],
    [[3, 14, 15], [10, 10, 9, 9, 9],
     [3, 3, 4, 4, 5, 6, 6, 7, 7, 8, 11, 11, 12, 12, 13, 13]],
    p[0], 'landlord', 0);
  var res = AI.decidePlay(ctx);
  report('P7', ctx, res, res && res.combo.main === 3
    ? '  ←⚠ 先领 3 → 被 10 压 → 10,9,9,9 三带一报胜！' : '  （先出 A/2 ✓）');
});

console.log('\n=== P8 必胜链·跟牌侧同款：农民领 5，AI=[3,A,2] 应回收后走完（不应放行）===');
[[0, 'hard'], [0, 'master']].forEach(function (p) {
  var ctx = build(p[1],
    [[3, 14, 15], [10, 10, 9, 9, 9],
     [3, 3, 4, 4, 5, 6, 6, 7, 7, 8, 11, 11, 12, 12, 13, 13]],
    p[0], 'landlord', 0);
  ctx.lastCombo = Cards.parse([Cards.makeCard((5 - 3) * 4 + 3)]);
  ctx.lastSeat = 2;
  var res = AI.decidePlay(ctx);
  report('P8', ctx, res, res ? '  （压住 ✓）' : '  ←⚠ 放行小单给快赢的农民');
});
