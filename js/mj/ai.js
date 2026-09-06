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
 *   master 「大师」完全信息（看穿他家手牌与真实牌墙）：攻防随自己向听
 *          动态切换——听牌全力避炮、一向听偏防守、两向听以上纯进攻；
 *          存在安全候选时绝不点炮（必死张重罚），所有保向听候选都致命时
 *          以 foldProb 概率拆牌弃和、否则坚持听牌赌抢和；加杠前查他家听牌，
 *          必被抢杠的加杠直接放弃（仅 AI，人类玩家按钮不受限）；
 *          平级副露更积极（进张 0.85 阈值）；
 *          进张按真实牌墙余量计算
 * 纯逻辑模块，可在 Node 中直接 require 做单元测试。
 * ========================================================================== */
(function (global) {
  'use strict';

  var isNode = (typeof module !== 'undefined' && module.exports);
  var Tiles = isNode ? require('./tiles.js') : global.MjTiles;
  var Rules = isNode ? require('./rules.js') : global.MjRules;

  var CFG = {
    easy: { name: '新手', thinkMs: [1000, 3000], claimWhim: 0.4 },
    hard: { name: '高手', thinkMs: [1000, 3000], claimWhim: 0 },
    master: { name: '大师', thinkMs: [1000, 3000], claimWhim: 0 }
  };

  /**
   * 大师档点炮行为旋钮（tests/mj-sim.js 扫参标定用，运行时可改）：
   *   deadlyConst  点炮必死张的固定罚分。实测点炮只发生在「所有保向听候选
   *                都致命」的局面（罚分等量作用于全体候选，改大小无效，
   *                30/35/50/100000 轨迹完全一致），故此值只需保证「存在安全
   *                候选时必不点炮」即可，无需标定。
   *   foldProb     全致命时拆牌弃和的概率：以 (1−foldProb) 概率坚持听牌赌
   *                抢和（真人大师「多数弃和、偶尔玉碎」的画像）。点炮率的
   *                主旋钮。
   *   jiagangGuard 加杠保安的执行概率：有人正听这张牌时放弃加杠（1 = 必拦）。
   *                完全信息下宣杠必被抢，等于送炮；已碰之牌的第 4 张对牌型
   *                毫无贡献，拦下只损失岭上收益。仅对 AI 生效——人类玩家的
   *                加杠按钮不受影响，是否冒险由玩家自己决定。
   */
  var TUNE = {
    deadlyConst: 30,
    foldProb: 0.75,
    jiagangGuard: 1
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
    var d = Tiles.isHonor(idx) ? 3 : (Tiles.isTerminal(idx) ? 4 : 6);
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
    // 第一轮：打完后的向听（顺带标记点炮必死张，供弃和逻辑全候选使用）
    for (i = 0; i < 34; i++) {
      if (c[i] === 0) continue;
      c[i]--;
      var sh = cachedShanten(c, budget);
      c[i]++;
      cands.push({ drop: i, shanten: sh, deadly: !!(deadly && deadly[i]) });
    }
    if (!cands.length) return cands;
    var bestSh = Math.min.apply(null, cands.map(function (x) { return x.shanten; }));

    // 第二轮：只对向听最优的候选算进张（避免 14×34 次向听全算）
    var finalists = cands.filter(function (x) { return x.shanten === bestSh; });
    // 大师攻防随向听切换：听牌全力避炮，离听越远越偏进攻。
    // 防守在自身离和牌尚远时毫无价值，只会拖慢自己（旧版恒 2.2 导致
    // 大师「只守不攻」，实测强度与高手持平）。
    var dw = 0.6;
    if (ctx.difficulty === 'master') {
      if (bestSh <= 0) dw = 2.6;        // 听牌：避炮收益最大
      else if (bestSh === 1) dw = 1.6;  // 一向听：偏防守
      else if (bestSh === 2) dw = 0.6;  // 两向听：进攻优先
      else dw = 0;                       // 三向听以上：纯效率进攻
    }
    // 竞速模式：完全信息下已知他家有人听牌 → 进张权重加码，
    // 全力抢在听牌家之前和牌（直接压缩对手的获胜窗口）
    var raceMode = false;
    if (ctx.difficulty === 'master' && ctx.hands) {
      for (var s2 = 0; s2 < ctx.hands.length; s2++) {
        if (s2 === ctx.seat) continue;
        var ob = 4 - (ctx.meldCounts ? (ctx.meldCounts[s2] || 0) : 0);
        if (cachedShanten(Tiles.countsOf(ctx.hands[s2]), ob) === 0) { raceMode = true; break; }
      }
    }
    var uw = (ctx.difficulty === 'master' && raceMode) ? 3 : 2;
    for (t = 0; t < finalists.length; t++) {
      var f = finalists[t];
      if (ctx.difficulty === 'easy') {
        f.ukeire = { count: 0, kinds: 0 };
      } else {
        f.ukeire = Rules.ukeire(c, budget, f.drop, unseen);
      }
      f.danger = dangerOf(f.drop, ctx);
      // 大师：点炮必死张固定重罚——作用是「存在安全候选时必不点炮」；
      // 全致命局面的处置见 decideDiscard 的弃和逻辑（罚分大小在那里无效）
      f.deadlyPen = f.deadly ? TUNE.deadlyConst : 0;
      f.keep = keepValue(c, f.drop);
    }

    finalists.sort(function (a, b) {
      // 新手：按保留价值（隐约有点牌感）+ 随机
      if (ctx.difficulty === 'easy') {
        return (b.keep + Math.random() * 3) - (a.keep + Math.random() * 3);
      }
      // 高手/大师：进张优先（大师竞速模式下加码）；危险度按上方的
      // 攻防权重折算，点炮必死张另计固定罚分（见 TUNE 注释）
      var da = (ctx.opponentTenpaiish ? dw * a.danger : 0.3 * a.danger) + a.deadlyPen;
      var db = (ctx.opponentTenpaiish ? dw * b.danger : 0.3 * b.danger) + b.deadlyPen;
      var va = a.ukeire.count * uw - da + a.keep * 0.3;
      var vb = b.ukeire.count * uw - db + b.keep * 0.3;
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
    // 大师弃和：排到第一的是点炮必死张，说明所有保向听候选都致命（有安全
    // 候选时它已被重罚压下去）。此时以 foldProb 概率拆牌弃和——优先在非致命
    // 候选里挑最安全的一张退向听；否则坚持听牌赌抢和（玉碎）。真人大师被
    // 听死时多数弃和、偶尔硬顶，点炮率由此旋钮标定
    if (ctx.difficulty === 'master' && ranked[0].deadly &&
      Math.random() < TUNE.foldProb) {
      var pool = [], i, safe = [];
      for (i = 0; i < ranked.length; i++) {
        if (!ranked[i].deadly) safe.push(ranked[i]);
      }
      pool = safe.length ? safe : ranked;
      var best = null, bestScore = Infinity;
      for (i = 0; i < pool.length; i++) {
        // 弃和选牌：安全第一（危险度最小），同险保留价值优先（保搭子少拆好形）
        var s = dangerOf(pool[i].drop, ctx) * 10 - keepValue(ctx.counts, pool[i].drop) * 0.1;
        if (s < bestScore) { bestScore = s; best = pool[i].drop; }
      }
      if (best !== null) return best;
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
      // 平级副露：大师在进张不明显变差时更积极地碰吃推进
      //（0.85 阈值：允许小幅进张损失换取副露推进与局面压迫）
      if (ctx.difficulty !== 'master') return false;
      var u0 = Rules.ukeire(ctx.counts, ctx.meldBudget, null, ctx.unseen);
      var u1 = Rules.ukeire(c1, ctx.meldBudget - 1, null, ctx.unseen);
      return u1.count >= u0.count * 0.85;
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
    // 副露上限 4 组：满编后不再暗杠/加杠（meldBudget = 4 − 副露数 ≤ 0）；
    // 空墙同样不得开杠——杠后要从墙尾补 1 张岭上牌，无牌可补时杠会直接
    // 导致荒庄并吞掉自己的最后一弃（明杠在 buildClaims 已有同款守卫）
    if (!res.win && ctx.meldBudget > 0 && (ctx.wallLeft | 0) > 0) {
      var i;
      for (i = 0; i < 34; i++) {
        if (ctx.counts[i] === 4) { res.gangIdx = i; break; }
      }
      // 加杠：手里有已碰之牌的第 4 张
      var pengs = ctx.pengMelds || [];
      for (i = 0; i < pengs.length; i++) {
        if (ctx.counts[pengs[i]] >= 1) { res.jiagangIdx = pengs[i]; break; }
      }
      // 大师：杠后向听 ≤1 时不拆四张暗杠（可能破坏听牌）。
      // 暗杠后副露 +1，必须用杠后的预算（meldBudget - 1）评估——shanten
      // 公式含 -2×(4−budget) 修正项，用杠前预算会把阈值从 ≤1 漂移成 ≤3，
      // 系统性地放弃有利的暗杠
      if (res.gangIdx >= 0 && ctx.difficulty === 'master') {
        var c = ctx.counts.slice(); c[res.gangIdx] = 0;
        if (cachedShanten(c, ctx.meldBudget - 1) <= 1) res.gangIdx = -1;
      }
      // 加杠保安（仅 AI，大师完全信息）：若有人正听这张牌，宣杠必被抢——
      // 抢杠等于点炮且无法反悔。这张牌对牌型毫无贡献（3 张已在副露里），
      // 放弃加杠只损失岭上收益，故听牌命中即拦（概率由 TUNE.jiagangGuard
      // 控制）。人类座位不经此分支（selfCheckCtx 不为其传 hands），
      // 加杠按钮照常点亮，是否冒险由玩家自己决定
      if (res.jiagangIdx >= 0 && ctx.difficulty === 'master' &&
        ctx.hands && Math.random() < TUNE.jiagangGuard) {
        var jd = exactDeadly(ctx);
        if (jd && jd[res.jiagangIdx]) res.jiagangIdx = -1;
      }
    }
    return res;
  }

  global.MjAI = {
    CFG: CFG,
    TUNE: TUNE,
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
