/* 斗地主 —— 纯前端单机斗地主游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * decompose.js —— 手牌拆解器
 * 把一手牌拆成「最少出牌手数」的组合序列，是 AI 评估牌力的核心依据。
 * 例如 [3,4,5,6,7, 8,8] 拆为 [顺子 34567, 对8] = 2 手。
 *
 * 实现：候选着法生成 + 记忆化 DFS + 节点预算，超预算自动回退贪心解。
 * 纯逻辑模块，可在 Node 中直接 require 做单元测试。
 * ========================================================================== */
(function (global) {
  'use strict';

  var Cards = (typeof module !== 'undefined' && module.exports)
    ? require('./cards.js') : global.Cards;

  var RANK_MIN = 3, RANK_MAX = 17, STRAIGHT_MAX = 14;

  /* 两档搜索精度：
   *  full  —— 用于自己手牌的最终拆解，节点预算充足，结果更接近最优
   *  quick —— 用于 AI 逐个候选评估时的「出掉这手还剩几手」，允许近似
   * 两张记忆表分开存放，避免近似值污染精确值。
   */
  var QUALITY = {
    full: { budget: 25000, memo: new Map() },
    quick: { budget: 1200, memo: new Map() }
  };
  var MEMO_LIMIT = 120000;

  /* ---------------- 计数与着法表示 ---------------- */

  function countsOf(cards) {
    var c = new Array(18).fill(0);
    for (var i = 0; i < cards.length; i++) c[cards[i].rank]++;
    return c;
  }

  function total(c) {
    var s = 0;
    for (var r = RANK_MIN; r <= RANK_MAX; r++) s += c[r];
    return s;
  }

  /** 着法用长度 18 的数组表示：move[rank] = 该点数用掉的张数 */
  function apply(c, move) {
    var out = new Array(18);
    for (var r = 0; r < 18; r++) out[r] = c[r] - (move[r] || 0);
    return out;
  }

  function mv(list) {
    var m = new Array(18).fill(0);
    for (var i = 0; i < list.length; i += 2) m[list[i]] += list[i + 1];
    return m;
  }

  /* ---------------- 连续段枚举 ---------------- */

  /** 返回 ranks 中所有长度 >= minLen 的连续子段，按长度降序 */
  function runsOf(ranks, minLen, maxTake) {
    var out = [];
    var i = 0;
    while (i < ranks.length) {
      var j = i;
      while (j + 1 < ranks.length && ranks[j + 1] - ranks[j] === 1) j++;
      var seg = ranks.slice(i, j + 1);
      for (var L = seg.length; L >= minLen; L--) {
        for (var s = 0; s + L <= seg.length; s++) out.push(seg.slice(s, s + L));
      }
      i = j + 1;
    }
    out.sort(function (a, b) { return b.length - a.length; });
    return maxTake ? out.slice(0, maxTake) : out;
  }

  function ranksWith(c, need, maxRank) {
    var out = [];
    for (var r = RANK_MIN; r <= (maxRank || RANK_MAX); r++) if (c[r] >= need) out.push(r);
    return out;
  }

  /* ---------------- 翅膀选择 ---------------- */

  /** 挑最「没用」的 count 张单牌 / count 个对子当带牌 */
  function wingOptions(c, exclude, count, size) {
    var ex = {};
    for (var i = 0; i < exclude.length; i++) ex[exclude[i]] = true;
    var pool = [];
    for (var r = RANK_MIN; r <= STRAIGHT_MAX; r++) {
      if (ex[r]) continue;
      if (c[r] < size) continue;
      if (c[r] >= 4) continue;              // 不拆炸弹
      if (c[r] === 3 && size === 2) continue; // 不轻易拆三张去凑对
      pool.push(r);
    }
    if (pool.length < count) return [];
    // 优先用「张数少 + 点数小」的牌当带牌
    pool.sort(function (a, b) {
      if (c[a] !== c[b]) return c[a] - c[b];
      return a - b;
    });
    var sets = [];
    for (var off = 0; off + count <= pool.length && off < 2; off++) {
      var m = new Array(18).fill(0);
      for (var k = 0; k < count; k++) m[pool[off + k]] += size;
      sets.push(m);
    }
    return sets;
  }

  /* ---------------- 着法生成 ---------------- */

  function genMoves(c) {
    var out = [];
    var r, i, segs, m;

    /* 王炸 */
    if (c[16] > 0 && c[17] > 0) out.push(mv([16, 1, 17, 1]));

    /* 炸弹 */
    for (r = RANK_MIN; r <= 15; r++) if (c[r] === 4) out.push(mv([r, 4]));

    /* 顺子（长度 >= 5） */
    segs = runsOf(ranksWith(c, 1, STRAIGHT_MAX), 5, 10);
    for (i = 0; i < segs.length; i++) {
      m = new Array(18).fill(0);
      for (var a = 0; a < segs[i].length; a++) m[segs[i][a]] = 1;
      out.push(m);
    }

    /* 连对（长度 >= 3） */
    segs = runsOf(ranksWith(c, 2, STRAIGHT_MAX), 3, 8);
    for (i = 0; i < segs.length; i++) {
      m = new Array(18).fill(0);
      for (var b = 0; b < segs[i].length; b++) m[segs[i][b]] = 2;
      out.push(m);
    }

    /* 飞机（纯三顺，长度 >= 2） */
    segs = runsOf(ranksWith(c, 3, STRAIGHT_MAX), 2, 6);
    for (i = 0; i < segs.length; i++) {
      m = new Array(18).fill(0);
      for (var d = 0; d < segs[i].length; d++) m[segs[i][d]] = 3;
      out.push(m);
    }

    /* 三张及其带牌 */
    var tripRanks = ranksWith(c, 3, 15);
    for (i = 0; i < tripRanks.length; i++) {
      r = tripRanks[i];
      var base = new Array(18).fill(0);
      base[r] = 3;
      out.push(base);
      var w1 = wingOptions(c, [r], 1, 1);
      for (var p = 0; p < w1.length; p++) {
        var mm = base.slice();
        for (var q = 0; q < 18; q++) if (w1[p][q]) mm[q] += w1[p][q];
        out.push(mm);
      }
      var w2 = wingOptions(c, [r], 1, 2);
      for (var p2 = 0; p2 < w2.length; p2++) {
        var mm2 = base.slice();
        for (var q2 = 0; q2 < 18; q2++) if (w2[p2][q2]) mm2[q2] += w2[p2][q2];
        out.push(mm2);
      }
    }

    /* 四带二 / 四带两对 */
    for (r = RANK_MIN; r <= 15; r++) {
      if (c[r] !== 4) continue;
      var f1 = wingOptions(c, [r], 2, 1);
      for (var t = 0; t < f1.length; t++) {
        var f1m = new Array(18).fill(0); f1m[r] = 4;
        for (var u = 0; u < 18; u++) if (f1[t][u]) f1m[u] += f1[t][u];
        out.push(f1m);
      }
      var f2 = wingOptions(c, [r], 2, 2);
      for (var t2 = 0; t2 < f2.length; t2++) {
        var f2m = new Array(18).fill(0); f2m[r] = 4;
        for (var u2 = 0; u2 < 18; u2++) if (f2[t2][u2]) f2m[u2] += f2[t2][u2];
        out.push(f2m);
      }
    }

    /* 对子、单张（放最后，作为兜底） */
    for (r = RANK_MIN; r <= RANK_MAX; r++) if (c[r] >= 2) out.push(mv([r, 2]));
    for (r = RANK_MIN; r <= RANK_MAX; r++) if (c[r] >= 1) out.push(mv([r, 1]));

    return out;
  }

  /* ---------------- 贪心兜底 ---------------- */

  function greedyPath(c) {
    var path = [];
    var cur = c.slice();
    var guard = 0;
    while (total(cur) > 0 && guard++ < 40) {
      var moves = genMoves(cur);
      // 贪心：选「用掉牌最多」的一手（长牌型优先）
      var best = null, bestScore = -1;
      for (var i = 0; i < moves.length; i++) {
        var used = 0, bigBonus = 0;
        for (var r = 0; r < 18; r++) {
          used += moves[i][r];
          if (moves[i][r] && r >= 15) bigBonus -= 2; // 尽量别主动拆 2 和王
        }
        var score = used * 10 + bigBonus;
        if (score > bestScore) { bestScore = score; best = moves[i]; }
      }
      if (!best) break;
      path.push(best);
      cur = apply(cur, best);
    }
    return path;
  }

  /* ---------------- 记忆化搜索 ---------------- */

  function solve(c, budget, memo) {
    var key = c.join(',');
    var hit = memo.get(key);
    if (hit !== undefined) return hit;

    if (total(c) === 0) return 0;

    var best = Infinity;
    var moves = genMoves(c);
    for (var i = 0; i < moves.length; i++) {
      if (budget.n-- <= 0) break;
      var next = apply(c, moves[i]);
      var v = 1 + solve(next, budget, memo);
      if (v < best) best = v;
    }
    if (best === Infinity) best = greedyPath(c).length; // 预算耗尽，退回贪心

    if (memo.size < MEMO_LIMIT) memo.set(key, best);
    return best;
  }

  function buildPath(c, qualityName) {
    var q = QUALITY[qualityName] || QUALITY.full;
    var path = [];
    var cur = c.slice();
    var guard = 0;
    // 先做一次带预算的搜索把记忆表填起来，之后逐步走最优路径
    var budget = { n: q.budget };
    solve(cur, budget, q.memo);
    while (total(cur) > 0 && guard++ < 40) {
      var target = solve(cur, { n: 800 }, q.memo);
      var moves = genMoves(cur);
      var chosen = null;
      for (var i = 0; i < moves.length; i++) {
        var next = apply(cur, moves[i]);
        if (1 + solve(next, { n: 800 }, q.memo) === target) { chosen = moves[i]; break; }
      }
      if (!chosen) {
        var gp = greedyPath(cur);
        if (!gp.length) break;
        chosen = gp[0];
      }
      path.push(chosen);
      cur = apply(cur, chosen);
    }
    return path;
  }

  /* ---------------- 对外接口 ---------------- */

  /**
   * 缓存里只放「拆解路径」——一组纯数值的着法（move[rank] = 用掉几张），
   * 绝不能缓存具体的 Card 对象。
   *
   * 曾经踩过的坑：按「点数分布」做 key 却缓存了 Card 对象，结果当另一家
   * （或另一局）的手牌点数分布恰好相同时，会命中缓存拿到属于别人手牌的牌。
   * AI 照着这些牌出牌，按 id 从自己手里一张都删不掉，手牌永远不减少 —— 死循环。
   *
   * 着法只描述「每个点数用几张」，与具体是哪几张牌无关，因此缓存是安全的；
   * 真正的 Card 对象在每次调用时按当次传入的手牌还原。
   */
  var pathCache = new Map();   // countsKey -> Array<move>
  var CACHE_LIMIT = 3000;

  function cacheKey(cards) {
    var c = countsOf(cards);
    return c.join(',');
  }

  /** 取拆解路径（缓存），quality 仅 'full' 结果入缓存 */
  function pathFor(c, quality) {
    var full = (quality !== 'quick');
    var key = c.join(',');
    if (full) {
      var hit = pathCache.get(key);
      if (hit) return hit;
    }
    var p = buildPath(c, full ? 'full' : 'quick');
    if (full && pathCache.size < CACHE_LIMIT) pathCache.set(key, p);
    return p;
  }

  /**
   * 拆解手牌，返回 { count, hands }。
   * quality: 'full'（默认，精确）/ 'quick'（近似，供 AI 批量评估）
   * hands 为 Card[][]，按推荐出牌顺序排列（先出长牌型）。
   */
  function decompose(cards, quality) {
    if (!cards || !cards.length) return { count: 0, hands: [] };

    var c = countsOf(cards);
    var path = pathFor(c, quality);

    // 按着法路径，从「本次调用传入的」手牌里还原出具体的牌
    var pool = new Map();
    for (var i = 0; i < cards.length; i++) {
      if (!pool.has(cards[i].rank)) pool.set(cards[i].rank, []);
      pool.get(cards[i].rank).push(cards[i]);
    }
    pool.forEach(function (arr) { arr.sort(function (x, y) { return x.id - y.id; }); });

    var hands = [];
    for (var p = 0; p < path.length; p++) {
      var hand = [];
      var okHand = true;
      for (var r = 0; r < 18; r++) {
        var need = path[p][r] || 0;
        if (!need) continue;
        var arr = pool.get(r);
        if (!arr || arr.length < need) { okHand = false; break; }
        hand = hand.concat(arr.splice(0, need));
      }
      if (okHand && hand.length) hands.push(Cards.sortAsc(hand));
    }

    // 兜底：还原失败时（手牌与路径不匹配，理论不该发生）退回贪心路径重来
    if (!hands.length && total(countsOf(cards)) > 0) {
      var gp = greedyPath(countsOf(cards));
      var pool2 = new Map();
      for (var j = 0; j < cards.length; j++) {
        if (!pool2.has(cards[j].rank)) pool2.set(cards[j].rank, []);
        pool2.get(cards[j].rank).push(cards[j]);
      }
      pool2.forEach(function (a) { a.sort(function (x, y) { return x.id - y.id; }); });
      for (var q = 0; q < gp.length; q++) {
        var h2 = [];
        for (var r2 = 0; r2 < 18; r2++) {
          var n2 = gp[q][r2] || 0;
          if (!n2) continue;
          var a2 = pool2.get(r2);
          if (!a2 || a2.length < n2) { h2 = []; break; }
          h2 = h2.concat(a2.splice(0, n2));
        }
        if (h2.length) hands.push(Cards.sortAsc(h2));
      }
    }

    return { count: hands.length, hands: hands };
  }

  /** 只要手数。quality 默认 'full'；AI 批量评估时传 'quick' */
  function minHands(cards, quality) {
    if (!cards || !cards.length) return 0;
    var c = countsOf(cards);
    if (quality === 'quick') {
      var q = QUALITY.quick;
      var k = c.join(',');
      var hit = q.memo.get(k);
      if (hit !== undefined) return hit;
      return solve(c, { n: q.budget }, q.memo);
    }
    return pathFor(c, 'full').length;
  }

  var afterCache = new Map();

  /** 出掉 drop（Card[]）之后，剩余牌需要几手打完 */
  function minHandsAfter(cards, drop, quality) {
    var key = cacheKey(cards) + '|' + cacheKey(drop);
    var cached = afterCache.get(key);
    if (cached !== undefined) return cached;
    var rest = removeCards(cards, drop);
    var v = minHands(rest, quality);
    if (afterCache.size < 60000) afterCache.set(key, v);
    return v;
  }

  function removeCards(cards, drop) {
    var ids = new Set(drop.map(function (c) { return c.id; }));
    return cards.filter(function (c) { return !ids.has(c.id); });
  }

  function resetCache() {
    QUALITY.full.memo.clear();
    QUALITY.quick.memo.clear();
    pathCache.clear();
    afterCache.clear();
  }

  var API = {
    decompose: decompose,
    minHands: minHands,
    minHandsAfter: minHandsAfter,
    removeCards: removeCards,
    countsOf: countsOf,
    greedyPath: greedyPath,
    resetCache: resetCache
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.Decompose = API;

})(typeof window !== 'undefined' ? window : globalThis);
