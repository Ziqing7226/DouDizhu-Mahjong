/* 诊断脚本：复现「AI 必赢好牌却单走小牌，被对手最后一张拦下反杀」
 * 目标场景：AI 手握 三带一 + 顺子 + 散单张（拆解 ≥3 手），对手地主只剩 1 张
 * 比散单张大的牌。AI 唯一活路是先领顺子/三带一（单张地主永远压不起），
 * 若领出散单张则被地主一压直接输。
 */
'use strict';
var Cards = require('../js/cards.js');
var AI = require('../js/ai.js');

// 全副牌按点数取用：全局按点数分配 id，避免两手牌取到同一张牌（每个用例重置）
var usedGlobal = {};
function takeByRanks(ranks) {
  return ranks.map(function (r) {
    usedGlobal[r] = usedGlobal[r] || 0;
    if (usedGlobal[r] >= (r >= 16 ? 1 : 4)) throw new Error('点数 ' + r + ' 超过 4 张');
    var id = r >= 16 ? (r === 16 ? 52 : 53) : (r - 3) * 4 + usedGlobal[r]++;
    return Cards.makeCard(id);
  });
}

function runCase(name, difficulty, aiRanks, enemyRanks, otherRanks, aiIsLandlord) {
  usedGlobal = {};
  var hands = aiIsLandlord
    ? [takeByRanks(aiRanks), takeByRanks(otherRanks), takeByRanks(enemyRanks)]
    : [takeByRanks(enemyRanks), takeByRanks(aiRanks), takeByRanks(otherRanks)];
  var aiSeat = aiIsLandlord ? 0 : 1;
  var enemySeat = aiIsLandlord ? 2 : 0;
  var mateSeat = aiIsLandlord ? 1 : 2;
  // 已出牌 = 全副牌 − 三家手牌（硬凑成精确记牌，排除干扰）
  var onTable = new Set();
  hands.forEach(function (h) { h.forEach(function (c) { onTable.add(c.id); }); });
  var played = Cards.makeDeck().filter(function (c) { return !onTable.has(c.id); });

  var ctx = {
    difficulty: difficulty,
    hand: hands[aiSeat],
    seat: aiSeat,
    role: aiIsLandlord ? 'landlord' : 'farmer',
    landlordSeat: aiIsLandlord ? 0 : 0,
    teammateSeat: aiIsLandlord ? -1 : mateSeat,
    lastCombo: null,
    lastSeat: -1,
    counts: hands.map(function (h) { return h.length; }),
    played: played,
    hands: difficulty === 'master' ? hands.map(function (h) { return h.slice(); }) : null
  };
  var dec = require('../js/decompose.js').minHands(hands[aiSeat]);
  var res = AI.decidePlay(ctx);
  var led = res.cards.map(function (c) { return c.rank; }).sort(function (a, b) { return a - b; }).join(',');
  var lethal = (res.combo.type === Cards.CT.SINGLE) &&
    enemyRanks.some(function (r) { return r > res.combo.main; });
  console.log('[' + name + '/' + difficulty + '] 拆解=' + dec + '手  领出 → ' + led +
    '  tag=' + res.tag + (lethal ? '  ←⚠ 被敌人最后一张(' + enemyRanks.join('/') + ')压住，敌人直接获胜！'
      : '  （安全）'));
}

// ===== AI 为地主（下家农民只剩 1 张能压它散单的牌）=====
// 用例 1：AI 地主 = 三带一(999+2) + 顺子34567 + 散单K；农民只剩 A
var f1 = [3, 3, 4, 4, 5, 5, 10, 10, 11, 11, 12, 12, 8, 8, 6, 7];
runCase('地主-散单K-敌A', 'hard', [3, 4, 5, 6, 7, 9, 9, 9, 13, 15], [14], f1, true);
runCase('地主-散单K-敌A', 'master', [3, 4, 5, 6, 7, 9, 9, 9, 13, 15], [14], f1, true);
// 用例 2：AI 地主 = 三带一(777+4) + 顺子9-K + 散单5；农民只剩 6
var f2 = [3, 3, 6, 6, 8, 8, 10, 10, 11, 11, 12, 12, 14, 15, 13, 13];
runCase('地主-散单5-敌6', 'hard', [5, 7, 7, 7, 9, 10, 11, 12, 13, 4], [6], f2, true);
runCase('地主-散单5-敌6', 'master', [5, 7, 7, 7, 9, 10, 11, 12, 13, 4], [6], f2, true);
// 用例 3：AI 仍为农民，但把上面的牌换成「上家位」（地主上家，更容易放小单）
runCase('农民上家-散单5-敌6', 'hard', [5, 7, 7, 7, 9, 10, 11, 12, 13, 4], [6], f2, false);
runCase('农民上家-散单5-敌6', 'master', [5, 7, 7, 7, 9, 10, 11, 12, 13, 4], [6], f2, false);

// ===== 两手牌变体：AI = 单张K + 顺子34567（拆解恰好 2 手），敌人报单 A =====
//  正确：先领顺子（敌人 1 张永远压不起）→ 下轮领 K 获胜
//  预期错误：两手分支按 main 比大小 → 领 K → 被敌人 A 压掉 → 输
runCase('两手-单K+顺子', 'hard', [13, 3, 4, 5, 6, 7], [14], f1, true);
runCase('两手-单K+顺子', 'master', [13, 3, 4, 5, 6, 7], [14], f1, true);

// ===== 边界复查 =====
// A. 敌我同时报单（队友 5 / 敌人 6），AI 农民 = 单4 + 三带一(999+K)：
//    喂队友的 -14 不能压过防送胜的 +130，应先出三带一（随后单4直接走完获胜）
runCase('边界-敌我同时报单', 'hard', [4, 9, 9, 9, 13], [6], [5], false);
runCase('边界-敌我同时报单', 'master', [4, 9, 9, 9, 13], [6], [5], false);
// B. AI 全是散单张（3/8/J），敌人报单 9：手牌本身已无解，但必须仍能合法领出
//    （全部候选同等 +130，相对序不变，选最小牌力）
runCase('边界-全单张无解', 'hard', [3, 8, 11], [9], [4, 4, 5, 5, 6, 6, 7, 7, 10, 10, 12, 12, 13, 13, 15, 15], true);
// C. 两手都是危险单张（单K + 单9，敌人报单 A）：risky 相同 → 回退按 main 比大小，仍合法
runCase('边界-两手皆险单', 'hard', [13, 9], [14], [4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 10, 10, 11, 11, 12, 15], true);

// 合法性总检：所有用例的领出必须能被 Cards.parse 解析（引擎侧可正常打出）
