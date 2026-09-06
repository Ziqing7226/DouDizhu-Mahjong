/* 调试钩子 v2：决策时刻用真实 rankDiscards 预跑，检查 deadlyPen 是否真实生效。
 * 用法: MJ_HOOK=tests/mj-hook-deadly.js node tests/mj-sim.js N SEED */
'use strict';
var __dbg = { nDiscard: 0, samples: [], pend: null, hits: [] };

MjAI.decideDiscard = (function (orig) {
  return function (c) {
    __dbg.nDiscard++;
    var probe = null;
    if (c.hands) {
      probe = MjAI.rankDiscards(c);
      if (probe[0].deadly) {
        __dbg.samples.push({
          seat: c.seat, tuneConst: MjAI.TUNE.deadlyConst, foldProb: MjAI.TUNE.foldProb,
          drop: probe[0].drop, shanten: probe[0].shanten,
          ukeire: probe[0].ukeire.count, pen: probe[0].deadlyPen,
          danger: Math.round(probe[0].danger * 10) / 10
        });
      }
    }
    var drop = orig(c);
    if (c.hands && probe) {
      __dbg.pend = { seat: c.seat, drop: drop, probeTop: probe[0].drop };
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
        __dbg.hits.push({ seat: p.seat, drop: p.drop, probeTop: p.probeTop });
      }
    }
    return orig(counts, melds, winTile, selfDraw);
  };
})(MjRules.scoreHands);

globalThis.__dbgHits = function () {
  return JSON.stringify({
    nDiscard: __dbg.nDiscard,
    deadlyTopPicks: __dbg.samples.slice(0, 15),
    nDeadlyTop: __dbg.samples.length,
    dealInOnDeadlyTop: __dbg.hits
  });
};
