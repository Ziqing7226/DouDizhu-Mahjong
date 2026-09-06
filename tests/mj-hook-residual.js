/* 临时调试钩子（不提交）：核查 foldProb=1 时残余点炮的成因。
 * 对每次点炮事件记录：决策时刻该张是否在精确致命表内（flagged）、
 * 当时非致命候选数（safeCount，0 = 全致命被迫）。
 * 用法: MJ_HOOK=tests/mj-hook-residual.js MJ_TUNE=foldProb:1 node tests/mj-sim.js N SEED */
'use strict';
var __dbg = { pend: null, hits: [] };

MjAI.decideDiscard = (function (orig) {
  return function (c) {
    var drop = orig(c);
    if (c.hands) {
      var opp = [];
      for (var s = 0; s < 4; s++) opp.push(MjTiles.countsOf(c.hands[s].slice()));
      __dbg.pend = { seat: c.seat, drop: drop, opp: opp, melds: c.meldCounts.slice() };
    }
    return drop;
  };
})(MjAI.decideDiscard);

MjRules.scoreHands = (function (orig) {
  return function (counts, melds, winTile, selfDraw) {
    if (!selfDraw && __dbg.pend) {
      var p = __dbg.pend;
      __dbg.pend = null;
      if (p.drop === winTile.idx) {
        // 决策时刻重算：这张是否致命 + 全候选非致命张数量
        var deadly = new Array(34);
        var safeCount = 0;
        for (var s2 = 0; s2 < 4; s2++) {
          if (s2 === p.seat) continue;
          var ob = 4 - p.melds[s2];
          var oc = p.opp[s2].slice();
          if (MjRules.shanten(oc, ob) !== 0) continue;
          for (var t = 0; t < 34; t++) {
            if (oc[t] >= 4) continue;
            oc[t]++;
            if (MjRules.isWin(oc, ob)) deadly[t] = true;
            oc[t]--;
          }
        }
        // 手牌各张是否致命（14 张 = counts + 刚打出的那张）
        for (var k = 0; k < 34; k++) {
          if (!deadly[k]) safeCount += p.opp[p.seat][k];   // 用打出前的手牌计数
        }
        __dbg.hits.push({
          seat: p.seat, tile: winTile.idx,
          flagged: !!deadly[winTile.idx], safeCount: safeCount
        });
      }
    }
    return orig(counts, melds, winTile, selfDraw);
  };
})(MjRules.scoreHands);

globalThis.__dbgHits = function () {
  return JSON.stringify(__dbg.hits);
};
