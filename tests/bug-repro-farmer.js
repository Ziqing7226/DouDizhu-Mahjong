/* 诊断脚本（第二轮）：三处配合/送胜问题
 * 1. AI 领出可被压的小对子，送给「剩两对小牌」的对手（对子版送胜）
 * 2. 对手剩 ≤4 张领出对子时，AI 跟牌不拦截（threat 仅 16，拆牌代价高就放行）
 * 3. master 农民不接队友喂牌（isTeammate 接牌门限写死 difficulty==='hard'）
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
// 构造跟牌用 lastCombo（用第 4 花色的 id，与三家手牌不撞）
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

function report(name, ctx, res, judge) {
  var led = res && res.cards ? res.cards.map(function (c) { return c.rank; })
    .sort(function (a, b) { return a - b; }).join(',') : '(不要)';
  console.log('[' + name + '/' + ctx.difficulty + '] ' + (ctx.lastCombo ? '跟牌' : '领出') +
    ' → ' + led + '  tag=' + ((res && res.tag) || 'pass') + (judge ? judge(res) : ''));
}

console.log('=== 用例 1：AI 地主领出，农民剩两对小牌(55/66)，AI 手握 44/77/QQ 三对 ===');
[[0, 'hard'], [0, 'master']].forEach(function (p) {
  var ctx = build(p[1],
    [[4, 4, 7, 7, 12, 12], [5, 5, 6, 6], [3, 3, 8, 8, 10, 10, 13, 13, 14, 14, 9, 9, 15, 6]],
    p[0], 'landlord', 0, null, -1);
  report('对子送胜', ctx, AI.decidePlay(ctx), function (r) {
    return r && r.combo.main <= 5 ? '  ←⚠ 被 55 接走 → 农民 66 报胜！' : '  （安全）';
  });
});

console.log('\n=== 用例 2：农民(两对 55/66)领出对 55，AI 地主手握 99(嵌顺子)+33 ===');
[[0, 'hard'], [0, 'master']].forEach(function (p) {
  var ctx = build(p[1],
    [[3, 3, 5, 6, 7, 8, 9, 9], [5, 5, 6, 6], [10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15]],
    p[0], 'landlord', 0, [5, 5], 1);
  report('拦截报双对', ctx, AI.decidePlay(ctx), function (r) {
    return r ? '  （用 99 拦截 ✓）' : '  ←⚠ 放行 → 农民 66 报胜！';
  });
});

console.log('\n=== 用例 3：农民AI 领出喂牌，队友只剩一对 66（农民1 → 队友2 直连）===');
[[1, 'hard'], [1, 'master']].forEach(function (p) {
  var ctx = build(p[1],
    [[10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15, 5, 5, 9, 9, 6, 6, 7, 7],
     [4, 4, 9, 9, 3, 13, 15, 8, 7],
     [6, 6]],
    p[0], 'farmer', 0, null, -1);
  report('喂队友', ctx, AI.decidePlay(ctx), function (r) {
    return r && r.combo.main < 6 ? '  （喂小牌 ✓）' : '  ←⚠ 队友接不走';
  });
});

console.log('\n=== 用例 4：队友已喂出单张 3，农民(剩对66)能否接牌获胜 ===');
[[2, 'hard'], [2, 'master']].forEach(function (p) {
  var ctx = build(p[1],
    [[10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15, 5, 5, 9, 9, 6, 6, 7, 7],
     [4, 4, 9, 9, 3, 13, 15, 8, 7],
     [6, 6]],
    p[0], 'farmer', 0, [3], 1);
  report('接喂牌', ctx, AI.decidePlay(ctx), function (r) {
    return r ? '  （接牌 → 66 报胜 ✓）' : '  ←⚠ 拒接 → 喂牌链条断裂！';
  });
});
