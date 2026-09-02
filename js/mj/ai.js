/* 斗地主&麻将 · 棋牌合集 —— 纯前端单机游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * mj/ai.js —— 麻将 AI 决策（出牌选择 / 副露取舍 / 胡牌必然宣言）
 * 难度档与斗地主同构：
 *   easy   「新手」出牌只看单张价值，副露全凭心血来潮，不数进张
 *   hard   「高手」最小向听 + 最大进张（受入牌）选择打牌，副露以向听改善为准
 *   master 「大师」在高手之上加入防守（他家似听牌时避开生张/中张）、
 *          吃碰选择比较进张质量、杠前确认岭上有牌
 * 纯逻辑模块，可在 Node 中直接 require 做单元测试。
 * ========================================================================== */
(function (global) {
  'use strict';

  var isNode = (typeof module !== 'undefined' && module.exports);
  var Tiles = isNode ? require('./tiles.js') : global.MjTiles;
  var Rules = isNode ? require('./rules.js') : global.MjRules;

  var CFG = {
    easy: { name: '新手', thinkMs: [450, 950], claimWhim: 0.4 },
    hard: { name: '高手', thinkMs: [650, 1300], claimWhim: 0 },
    master: { name: '大师', thinkMs: [850, 1700], claimWhim: 0 }
  };

  /* ---------------- 向听缓存 ---------------- */

  var shantenCache = new Map();
  function cachedShanten(c, budget) {
    var key = budget + '|' + c.join(',');
    var v = shantenCache.get(key);
    if (v === undefined) {
      v = Rules.shanten(c, budget);
      if (shantenCache.size > 60000) shantenCache.clear();
      shantenCache.set(key, v);
    }
    return v;
  }
  function resetCache() { shantenCache.clear(); }

  /* ---------------- 单张保留价值 / 危险度 ---------------- */

  /** 数牌间的距离（同花色 1-9；字牌 Infinity） */
  function numDist(a, b) {
    if (a >= 27 || b >= 27) return Infinity;
    if (Tiles.suitOf(a) !== Tiles.suitOf(b)) return Infinity;
    return Math.abs(a - b);
  }

  /** 打出 drop 后的保留价值：剩余牌相互配合越好越高 */
  function keepValue(c, drop) {
    c[drop]--;
    var v = 0;
    for (var i = 0; i < 34; i++) {
      if (c[i] >= 2) v += c[i] * 2;               // 对子
      for (var j = i + 1; j < 34; j++) {
        if (c[j] === 0) continue;
        var d = numDist(i, j);
        if (d === 1 || d === 2) v += 1.5;          // 两面/嵌张搭子
      }
      if (i < 27 && i % 9 <= 6 && c[i] > 0 && c[i + 1] > 0 && c[i + 2] > 0) v += 2; // 已成顺
      if (c[i] === 1 && (Tiles.isHonor(i) || Tiles.isTerminal(i))) v -= 0.8;  // 孤张幺九字
    }
    c[drop]++;
    return v;
  }

  /**
   * 危险度（越大越不该打）：他家似听牌时，生张中张最危险，
   * 任何一家河里出现过的牌对那张牌的听家是安全的（振听原理）。
   */
  function dangerOf(idx, ctx) {
    var d = Tiles.isHonor(idx) ? 3 : ((idx % 9 === 0 || idx % 8 === 0) ? 4 : 6);
    var seen = 4 - (ctx.unseen ? ctx.unseen[idx] : 0);
    d -= Math.min(2, seen);
    var rivers = ctx.opponentRivers || [];
    for (var s = 0; s < rivers.length; s++) {
      if (rivers[s] && rivers[s].indexOf(idx) >= 0) d -= 4;
    }
    return Math.max(0, d);
  }

  /* ---------------- 出牌决策 ---------------- */

  /**
   * 大师档完全信息（作弊难度，与斗地主大师同构）：
   * 直接看他家手牌，精确回答「谁在听牌、听哪些张」—— 而不是估概率。
   * 返回 34 长度的布尔表：true = 有听牌家正等这张（打出必点炮）。
   */
  function exactDeadly(ctx) {
    if (!ctx.hands || ctx.difficulty !== 'master') return null;
    var deadly = new Array(34).fill(false);
    for (var s = 0; s < ctx.hands.length; s++) {
      if (s === ctx.seat) continue;
      var oc = Tiles.countsOf(ctx.hands[s]);
      var ob = 4 - (ctx.meldCounts ? (ctx.meldCounts[s] || 0) : 0);
      if (cachedShanten(oc, ob) !== 0) continue;   // 只防真实听牌家
      for (var t = 0; t < 34; t++) {
        if (oc[t] >= 4) continue;
        oc[t]++;
        if (Rules.isWin(oc, ob)) deadly[t] = true;
        oc[t]--;
      }
    }
    return deadly;
  }

  /**
   * 枚举所有候选打牌并按质量排序。
   * ctx: { difficulty, seat, counts, meldBudget, unseen, wallUnseen, hands, meldCounts,
   *        opponentRivers, opponentTenpaiish }
   * hands / meldCounts / wallUnseen 仅大师档传入（完全信息）。
   * 返回 [{ drop, shanten, ukeire:{count,kinds}, danger }]
   */
  function rankDiscards(ctx) {
    var c = ctx.counts;
    var budget = ctx.meldBudget;
    var unseen = ctx.wallUnseen || ctx.unseen;   // 大师用真实牌墙余量算进张
    // 完全信息下的精确危险张（点炮必死表）
    var deadly = exactDeadly(ctx);

    var cands = [];
    var i, t;
    // 第一轮：打完后的向听
    for (i = 0; i < 34; i++) {
      if (c[i] === 0) continue;
      c[i]--;
      var sh = cachedShanten(c, budget);
      c[i]++;
      cands.push({ drop: i, shanten: sh });
    }
    if (!cands.length) return cands;
    var bestSh = Math.min.apply(null, cands.map(function (x) { return x.shanten; }));

    // 第二轮：只对向听最优的候选算进张（避免 14×34 次向听全算）
    var finalists = cands.filter(function (x) { return x.shanten === bestSh; });
    for (t = 0; t < finalists.length; t++) {
      var f = finalists[t];
      if (ctx.difficulty === 'easy') {
        f.ukeire = { count: 0, kinds: 0 };
      } else {
        f.ukeire = Rules.ukeire(c, budget, f.drop, unseen);
      }
      f.danger = dangerOf(f.drop, ctx);
      // 大师：点炮必死的张直接顶格危险（除非别无选择）
      if (deadly && deadly[f.drop]) f.danger = 100;
      f.keep = keepValue(c, f.drop);
    }

    finalists.sort(function (a, b) {
      // 新手：按保留价值（隐约有点牌感）+ 随机
      if (ctx.difficulty === 'easy') {
        return (b.keep + Math.random() * 3) - (a.keep + Math.random() * 3);
      }
      // 高手/大师：进张优先；大师在意危险度，高手只做轻微规避
      var dw = ctx.difficulty === 'master' ? 2.2 : 0.6;
      var da = (ctx.opponentTenpaiish ? dw * a.danger : 0.3 * a.danger);
      var db = (ctx.opponentTenpaiish ? dw * b.danger : 0.3 * b.danger);
      var va = a.ukeire.count * 2 - da + a.keep * 0.3;
      var vb = b.ukeire.count * 2 - db + b.keep * 0.3;
      return vb - va;
    });
    return finalists.concat(cands.filter(function (x) { return x.shanten !== bestSh; }));
  }

  /** AI 出牌：返回要打的 idx。ctx 同 rankDiscards */
  function decideDiscard(ctx) {
    var ranked = rankDiscards(ctx);
    if (!ranked.length) return null;
    if (ctx.difficulty === 'easy' && Math.random() < 0.25) {
      // 新手偶尔手滑，打个不是最差的
      return ranked[Math.min(ranked.length - 1, (Math.random() * ranked.length) | 0)].drop;
    }
    return ranked[0].drop;
  }

  /** 提示按钮：循环候选打牌（按高手思路排序，大师档由调用方禁用） */
  function hintCandidates(ctx) {
    return rankDiscards(ctx).map(function (x) { return x.drop; });
  }

  /* ---------------- 副露 / 胡牌决策 ---------------- */

  /**
   * 是否吃/碰某张牌。
   * ctx: { difficulty, counts, meldBudget, unseen, opponentTenpaiish }
   * tile: 打出的牌 idx；kind: 'peng' | 'chi'；runOption: 吃时 [a,b,c]（含 tile）
   * meldBudget 为当前（吃/碰前）预算。
   * 基线 s0 是「过」之后的手牌向听（那张牌会被别人拿走，不在手里），
   * 而不是「把它拿进来」的向听 —— 否则吃碰永远显得不划算。
   * 返回 Boolean。
   */
  function shouldClaimSet(ctx, tile, kind, runOption) {
    var cfg = CFG[ctx.difficulty] || CFG.hard;
    var s0 = cachedShanten(ctx.counts, ctx.meldBudget);
    var c1 = ctx.counts.slice();
    if (kind === 'peng') {
      if (c1[tile] < 2) return false;
      c1[tile] -= 2;
    } else {
      // 吃：手里要有顺子中「除被吃那张以外」的另外两张
      for (var i = 0; i < 3; i++) {
        if (runOption[i] === tile) continue;
        if (c1[runOption[i]] <= 0) return false;
        c1[runOption[i]]--;
      }
    }
    var s1 = cachedShanten(c1, ctx.meldBudget - 1);

    if (ctx.difficulty === 'easy') {
      // 新手看心情：向听变差也可能碰
      return s1 <= s0 + 1 && Math.random() < cfg.claimWhim + 0.25;
    }
    if (s1 < s0) return true;
    if (s1 === s0) {
      // 平级副露：只在进张不变差且是大师时才做（加快推进）
      if (ctx.difficulty !== 'master') return false;
      var u0 = Rules.ukeire(ctx.counts, ctx.meldBudget, null, ctx.unseen);
      var u1 = Rules.ukeire(c1, ctx.meldBudget - 1, null, ctx.unseen);
      return u1.count >= u0.count * 0.9;
    }
    return false;
  }

  /** 明杠（别家打出的第 4 张）：新手/高手无脑杠，大师确认岭上还有牌（wallLeft 由 ctx 传） */
  function shouldKong(ctx) {
    if (ctx.difficulty === 'master' && (ctx.wallLeft | 0) <= 4) return false;
    return true;
  }

  /** 胡牌：任何难度都胡 */
  function shouldWin() { return true; }

  /**
   * 摸牌后的自立决策：是否自摸胡 / 暗杠 / 加杠。
   * ctx: { counts, meldBudget, wallLeft, pengMelds(已碰牌的 idx 数组), difficulty }
   * 返回 { win:Boolean, gangIdx(Number|-1 暗杠), jiagangIdx(Number|-1 加杠) }
   */
  function selfCheck(ctx) {
    var res = { win: Rules.isWin(ctx.counts, ctx.meldBudget), gangIdx: -1, jiagangIdx: -1 };
    if (!res.win) {
      var i;
      for (i = 0; i < 34; i++) {
        if (ctx.counts[i] === 4) { res.gangIdx = i; break; }
      }
      // 加杠：手里有已碰之牌的第 4 张
      var pengs = ctx.pengMelds || [];
      for (i = 0; i < pengs.length; i++) {
        if (ctx.counts[pengs[i]] >= 1) { res.jiagangIdx = pengs[i]; break; }
      }
      // 大师：向听 ≤1 时不拆四张暗杠（可能破坏听牌）
      if (res.gangIdx >= 0 && ctx.difficulty === 'master') {
        var c = ctx.counts.slice(); c[res.gangIdx] = 0;
        if (cachedShanten(c, ctx.meldBudget) <= 1) res.gangIdx = -1;
      }
    }
    return res;
  }

  global.MjAI = {
    CFG: CFG,
    resetCache: resetCache,
    rankDiscards: rankDiscards,
    decideDiscard: decideDiscard,
    hintCandidates: hintCandidates,
    shouldClaimSet: shouldClaimSet,
    shouldKong: shouldKong,
    shouldWin: shouldWin,
    selfCheck: selfCheck,
    dangerOf: dangerOf
  };

  if (isNode) module.exports = global.MjAI;

})(typeof window !== 'undefined' ? window : globalThis);
