/* 斗地主 —— 纯前端单机斗地主游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * ai.js —— AI 玩家决策（叫分 / 加倍 / 领出 / 跟牌压制）
 * 难度档（发布形态三档；normal 保留为内部测试基准档，不出现在 UI）：
 *   easy   「新手」只做最基本的合法性判断，出牌偏随机，不用炸弹，不记牌
 *   normal （内部档）贪心拆牌 + 结构评估，会压牌、会留炸，不记牌
 *   hard   「高手」在 normal 之上加入记牌（未出现的牌精确推算）、对手压制力判定、
 *          必胜链搜索、逃牌封堵、队友配合 —— 实测性价比最高的一套机制
 *   master 「大师」完全信息 AI（能看到所有人手牌），提示功能对玩家禁用，
 *          思考预算放宽到 3 秒内
 *
 * 高手档的核心思想：未出现的牌 = 54 − 自己手牌 − 已出牌，必然全部在对手手上。
 * 因此「对手是否压得起某一手牌」可以被**精确**回答，而不是估概率 ——
 * 这是本档所有强决策的地基。
 * 纯逻辑模块，可在 Node 中直接 require 做单元测试。
 * ========================================================================== */
(function (global) {
  'use strict';

  var isNode = (typeof module !== 'undefined' && module.exports);
  var Cards = isNode ? require('./cards.js') : global.Cards;
  var Dec = isNode ? require('./decompose.js') : global.Decompose;
  var CT = Cards.CT;

  /* ---------------- 点数价值表 ---------------- */
  var POWER = {
    3: 0.45, 4: 0.6, 5: 0.75, 6: 0.9, 7: 1.05, 8: 1.2, 9: 1.35, 10: 1.5,
    11: 1.9, 12: 2.1, 13: 2.3, 14: 3.0, 15: 4.2, 16: 6.0, 17: 7.0
  };

  /** 该座位是否为我的敌人（农民视地主为敌，地主视其余两家为敌） */
  function isEnemySeat(ctx, seat) {
    if (seat === ctx.seat) return false;
    if (ctx.role === 'landlord') return true;
    return seat === ctx.landlordSeat;
  }

  function powerOf(cards) {
    var s = 0;
    for (var i = 0; i < cards.length; i++) s += POWER[cards[i].rank] || 0;
    return s;
  }

  /* ---------------- 特性开关（A/B 定位用，bench 可覆盖） ---------------- */
  var FEAT = {
    forcedWin: true,      // 必胜链搜索（精确，实测有益）
    rollout: true,        // 残局摊牌推演（实测有益）
    rolloutAlways: false, // 非残局也推演（实测明显掉分，务必保持 false）
    endgameN: 9,          // 残局判定阈值
    position: true,       // 农民定位配合（上家放小/下家顶牌）
    rolloutK: 60,         // 残局推演每个候选的采样次数
    // 残局感知的推演续打策略（对手快赢不送单/喂队友/危局解炸弹罚）。
    // 实测（hard@0 vs normal 300 局固定牌局配对，同种子）：
    //   关 diff +0.07，开 diff +0.08（+0.006，噪声级）；配合阈值放宽到 12 反而 +0.06。
    //   推演策略升级不转化为胜率，默认关闭，保留供后续实验。
    smartRollout: false,
    // 三人残局精确求解替代推演（仅 hard/master 生效）。
    // 引擎正确（14 个手推用例全对）、性能达标（平均 3.4k 节点/次 ≈ 15ms，最贵不超 solveCap），
    // 但实测不转化为强度：150 局固定牌局配对 master@0 vs hard，
    //   基线 diff +0.02(t=0.12) → 接管 +0.08(t=0.46) → 扩展接管(total≤24) −0.02(t=−0.12)，全噪声级。
    // 根因：残局「真决策点」仅 ~0.6 次/局（其余是跟不起/不压队友/一手走完/必胜链等强制路径），
    // 且这些点上求解结果与推演选择几乎一致；中盘(三家总牌数>28)真决策占 82%，精确求解不可行。
    // 默认关闭，引擎保留（solveEndgame 可导出复用，诊断钩子见 PIMC_STATS.onSolve）。
    pimc: false,
    pimcBudget: 1200000,  // 每次决策的求解节点总预算（约 2~5 秒上限）
    pimcSolveCap: 200000, // 单次求解的节点上限，超限返回 null 交回推演/启发式
    pimcMax: 12,          // PIMC 覆盖的最大手牌数（perfectInfo 档）
    pimcTotalMax: 24,     // 或：三家总牌数 ≤ 此值即接管（覆盖 15/4/5 型稀疏残局）
    // 大师档（完全信息）推演预算：决策允许最长约 3 秒（masterBudget 是红线，不是目标）。
    // 关键实测：complete-info 下 determinize 直接返回真实手牌，每次采样结果完全相同，
    //   因此 rolloutKMaster 只是把同一局棋重复算 N 遍 —— 150 局对照 K=3000 与 K=60
    //   的 diff 逐位相同（均 0.02 / sem 0.173 / t 0.12）。K 拉高纯属空转，故设 1。
    rolloutKMaster: 1,      // 大师档推演世界数（完全信息下多次采样等价，>1 无收益）
    masterBudget: 300000,   // 大师档单次决策推演步数上限（K=1 时实测最差 <3s）
    passBias: 0,          // 跟牌阈值：score > passBias 就选择不要（越大越激进）
    // 以下四项启发式经固定牌局 A/B 实测为负收益，默认关闭，仅保留供后续调优
    safeBonus: false,
    escapeBlock: false,
    mustBlock: false,
    holdsLead: false
  };

  /* ---------------- 难度参数 ---------------- */
  var CFG = {
    easy: {
      name: '新手',
      passChance: 0.2,
      bombPenalty: 999,
      leadBombPenalty: 999,
      useUnseen: false,
      teammateHelp: false,
      bidNoise: 3.5,
      bidBias: -1.5,
      superDouble: false,
      thinkMs: [1000, 3000]
    },
    normal: {
      name: '中等',
      passChance: 0,
      bombPenalty: 16,
      leadBombPenalty: 26,
      useUnseen: false,
      teammateHelp: true,
      bidNoise: 1.5,
      bidBias: 0,
      superDouble: false,
      thinkMs: [1000, 3000]
    },
    master: {
      name: '大师',
      passChance: 0,
      bombPenalty: 11,
      leadBombPenalty: 22,
      useUnseen: true,
      perfectInfo: true,     // 能看到所有人手牌（作弊难度）
      teammateHelp: true,
      bidNoise: 0,
      bidBias: 0.5,
      superDouble: true,
      thinkMs: [1000, 3000]
    },
    hard: {
      name: '高手',
      passChance: 0,
      bombPenalty: 11,
      leadBombPenalty: 22,
      useUnseen: true,
      teammateHelp: true,
      bidNoise: 0,
      bidBias: 0.5,
      superDouble: true,
      thinkMs: [1000, 3000]
    }
  };

  /* ================= 记牌：未出现的牌 ================= */

  /** unseen = 54 − 自己手牌 − 已出牌，必然全在另外两家手上 */
  function unseenCounts(myHand, played) {
    var c = new Array(18).fill(0);
    var r;
    for (r = 3; r <= 15; r++) c[r] = 4;
    c[16] = 1; c[17] = 1;
    for (var i = 0; i < myHand.length; i++) c[myHand[i].rank]--;
    if (played) for (var j = 0; j < played.length; j++) c[played[j].rank]--;
    for (r = 3; r <= 17; r++) if (c[r] < 0) c[r] = 0;
    return c;
  }

  /**
   * 对手是否「存在」能压过 combo 的牌？—— 用 unseen 计数精确回答。
   * 覆盖全部 14 种牌型，每种都是 O(点数×长度) 的直接判定，微秒级。
   * 返回 true 表示对手手里「可能」有牌能压（保守，按能压处理）。
   */
  function unseenHasBeat(uc, combo) {
    if (!combo || !uc) return false;
    var T = combo.type, M = combo.main, L = combo.len;
    var r, w, i;

    /* 长度为 len、每个点数张数 >= need、最高点 >= minTop 的连续段是否存在 */
    function hasRun(need, len, minTop) {
      for (var s = 3; s + len - 1 <= 14; s++) {
        if (s + len - 1 < minTop) continue;
        var ok = true;
        for (i = 0; i < len; i++) if (uc[s + i] < need) { ok = false; break; }
        if (ok) return true;
      }
      return false;
    }

    switch (T) {
      case CT.ROCKET:
        return false;

      case CT.BOMB:
        if (uc[16] > 0 && uc[17] > 0) return true;   // 火箭
        for (r = M + 1; r <= 15; r++) if (uc[r] === 4) return true;
        return false;

      case CT.SINGLE:
        for (r = M + 1; r <= 17; r++) if (uc[r] > 0) return true;
        return false;

      case CT.PAIR:
        for (r = M + 1; r <= 15; r++) if (uc[r] >= 2) return true;
        return false;

      case CT.TRIPLE:
        for (r = M + 1; r <= 15; r++) if (uc[r] >= 3) return true;
        return false;

      case CT.TRIPLE_ONE:
        for (r = M + 1; r <= 15; r++) {
          if (uc[r] < 3) continue;
          for (w = 3; w <= 17; w++) {
            if (uc[w] >= 1 && (w !== r || uc[w] >= 4)) return true;
          }
        }
        return false;

      case CT.TRIPLE_PAIR:
        for (r = M + 1; r <= 15; r++) {
          if (uc[r] < 3) continue;
          for (w = 3; w <= 15; w++) {
            if (w !== r && uc[w] >= 2) return true;
          }
        }
        return false;

      case CT.STRAIGHT:
        return hasRun(1, L, M + 1);

      case CT.DOUBLE_STRAIGHT:
        return hasRun(2, L, M + 1);

      case CT.TRIPLE_STRAIGHT:
        return hasRun(3, L, M + 1);

      case CT.AIRPLANE_ONE:
        for (var s1 = 3; s1 + L - 1 <= 14; s1++) {
          if (s1 + L - 1 <= M) continue;
          var ok1 = true;
          for (i = 0; i < L; i++) if (uc[s1 + i] < 3) { ok1 = false; break; }
          if (!ok1) continue;
          var spare = 0;                       // 翅膀来源：主体的第 4 张 + 其他所有牌
          for (w = 3; w <= 17; w++) {
            spare += (w >= s1 && w < s1 + L) ? (uc[w] - 3) : uc[w];
          }
          if (spare >= L) return true;
        }
        return false;

      case CT.AIRPLANE_PAIR:
        for (var s2 = 3; s2 + L - 1 <= 14; s2++) {
          if (s2 + L - 1 <= M) continue;
          var ok2 = true;
          for (i = 0; i < L; i++) if (uc[s2 + i] < 3) { ok2 = false; break; }
          if (!ok2) continue;
          var pairs = 0;
          for (w = 3; w <= 15; w++) {
            var n = (w >= s2 && w < s2 + L) ? (uc[w] - 3) : uc[w];
            if (n >= 2) pairs += (n / 2) | 0;
          }
          if (pairs >= L) return true;
        }
        return false;

      case CT.FOUR_TWO:
        for (r = M + 1; r <= 15; r++) {
          if (uc[r] !== 4) continue;
          var total = 0;
          for (w = 3; w <= 17; w++) if (w !== r) total += uc[w];
          if (total >= 2) return true;
        }
        return false;

      case CT.FOUR_TWO_PAIR:
        for (r = M + 1; r <= 15; r++) {
          if (uc[r] !== 4) continue;
          var pc = 0;
          for (w = 3; w <= 15; w++) {
            if (w === r) continue;
            if (uc[w] >= 4) return true;       // 同点数四张当两对
            if (uc[w] >= 2) pc++;
          }
          if (pc >= 2) return true;
        }
        return false;

      default:
        return false;
    }
  }

  /** 绝张：对手手里不存在任何能压过它的牌 → 打出去必然保住先手 */
  function isBoss(combo, uc) {
    return !!uc && !unseenHasBeat(uc, combo);
  }

  /**
   * 完全信息（大师档）：逐家精确判定「是否存在某一家压得起」。
   * 与合并估计的关键区别：一对 5 拆在两家手里时，合并估计会误判为可压，
   * 逐家判定则正确得出「没人压得起」—— 这类精确性正是大师档强度的来源。
   */
  function oppCanBeat(oppCounts, combo) {
    if (!oppCounts) return null;
    for (var i = 0; i < oppCounts.length; i++) {
      if (unseenHasBeat(oppCounts[i], combo)) return true;
    }
    return false;
  }

  /** 统一入口：完全信息用逐家精确判定，否则用合并估计 */
  function canOppBeat(ctx, uc, combo) {
    if (ctx.oppCounts) return oppCanBeat(ctx.oppCounts, combo);
    return unseenHasBeat(uc, combo);
  }

  /* ================= 必胜链搜索 ================= */

  /**
   * 关键洞察：只要我每一手都「对手压不起」，我就永远保住先手，
   * 对手一张牌都打不出去，直到我走完 —— 这是**充分条件**下的必胜。
   * 用记忆化 DFS 找这样一条出牌链，找到就照着打。
   */
  function winSolver(uc, beatFn) {
    var beat = beatFn || function (combo) { return unseenHasBeat(uc, combo); };
    var memo = new Map();
    var budget = { n: 9000 };

    function removeLocal(cards, drop) {
      var ids = new Set(drop.map(function (c) { return c.id; }));
      return cards.filter(function (c) { return !ids.has(c.id); });
    }

    /** 这手牌能否只靠「对手压不起」的牌全部打完 */
    function exists(cards) {
      if (!cards.length) return true;
      var key = Cards.rankCounts(cards).join(',');
      var hit = memo.get(key);
      if (hit !== undefined) return hit;
      if (budget.n-- <= 0) return false;      // 预算耗尽按失败处理（保守）

      var combos = allLeadCombos(cards);
      for (var i = 0; i < combos.length; i++) {
        var cd = combos[i];
        if (beat(cd.combo)) continue;
        if (exists(removeLocal(cards, cd.cards))) return true;
        if (budget.n <= 0) break;
      }
      memo.set(key, false);
      return false;
    }

    return {
      exists: exists,
      exhausted: function () { return budget.n <= 0; },
      /** 在 leadCands 里找出能开启必胜链的那一手 */
      pick: function (hand, cands) {
        for (var i = 0; i < cands.length; i++) {
          var cd = cands[i];
          if (unseenHasBeat(uc, cd.combo)) continue;
          var rest = removeLocal(hand, cd.cards);
          if (exists(rest)) return cd;
          if (budget.n <= 0) break;
        }
        return null;
      }
    };
  }

  /* ================= 三人残局精确求解（PIMC 核心件） ================= */

  /**
   * 完全信息三人残局求解：农民结盟（农民赢 = 任一农民走完）。
   * hands: 三家卡牌数组（会在内部复制/还原，不改原数组内容，但数组元素顺序可能变化，调用方传副本）。
   * 返回 1（地主赢）/ 0（农民赢）/ null（预算耗尽，无法断定）。
   * 记忆化 key = 三家点数分布 + 行动方 + 压牌状态；只缓存确定结果。
   */
  function solveEndgame(hands, turn, lastCombo, lastSeat, landlordSeat, budget) {
    // 诊断钩子：外部可注册 onSolve(lens) 观察求解触发时的规模分布
    if (API.PIMC_STATS && API.PIMC_STATS.onSolve) {
      API.PIMC_STATS.onSolve([hands[0].length, hands[1].length, hands[2].length]);
    }
    var memo = new Map();

    function keyOf(t, lc, ls) {
      // 排序点数串比 rankCounts+join 快一倍以上，残局手牌少时尤其明显
      return hands[0].map(function (c) { return c.rank; }).sort(function (a, b) { return a - b; }).join('') + '|' +
        hands[1].map(function (c) { return c.rank; }).sort(function (a, b) { return a - b; }).join('') + '|' +
        hands[2].map(function (c) { return c.rank; }).sort(function (a, b) { return a - b; }).join('') + '|' +
        t + '|' + (lc ? (lc.type + ':' + lc.main + ':' + (lc.len || 0)) : '-') + '|' + ls;
    }

    function dfs(t, lc, ls) {
      if (budget.n-- <= 0) return null;
      var hand = hands[t];
      if (!hand.length) return (t === landlordSeat) ? 1 : 0;
      // 一圈结束：两家都不要，行动方重新领出
      if (lc && ls === t) { lc = null; ls = -1; }

      var key = keyOf(t, lc, ls);
      var hit = memo.get(key);
      if (hit !== undefined) return hit;

      var iAmLandlord = (t === landlordSeat);
      var moves = [];
      if (!lc) {
        var combos = allLeadCombos(hand);
        for (var i = 0; i < combos.length; i++) moves.push(combos[i]);
      } else {
        var beats = Cards.findBeats(hand, lc);
        for (var j = 0; j < beats.length; j++) {
          var cb = Cards.parse(beats[j]);
          if (cb) moves.push({ cards: beats[j], combo: cb });
        }
        moves.push(null);   // 不要
      }
      // 着法排序：先试出牌多的（更接近走完），OR 搜索能更早剪枝；pass 天然在最后
      moves.sort(function (a, b) {
        return (b ? b.cards.length : 0) - (a ? a.cards.length : 0);
      });

      var moverWins = false, sawUnknown = false;
      for (var m = 0; m < moves.length; m++) {
        var mv = moves[m];
        var r;
        if (mv === null) {
          r = dfs((t + 1) % 3, lc, ls);
        } else {
          var ids = new Set(mv.cards.map(function (c) { return c.id; }));
          var rest = hand.filter(function (c) { return !ids.has(c.id); });
          hands[t] = rest;
          if (!rest.length) {
            // 打完立即获胜，终局 —— 不能继续往下搜
            hands[t] = hand;
            moverWins = true;
            break;
          }
          r = dfs((t + 1) % 3, mv.combo, t);
          hands[t] = hand;
        }
        if (r === null) { sawUnknown = true; continue; }
        // 子结果统一是「地主视角」：1=地主赢 0=农民赢
        var iWin = iAmLandlord ? (r === 1) : (r === 0);
        if (iWin) { moverWins = true; break; }   // OR 节点：找到一个赢着法即定
      }

      // 返回值同样统一为地主视角
      var result;
      if (moverWins) result = iAmLandlord ? 1 : 0;
      else if (!sawUnknown) result = iAmLandlord ? 0 : 1;
      else result = null;
      if (result !== null) memo.set(key, result);
      return result;
    }

    return dfs(turn, lastCombo, lastSeat);
  }

  /* ================= 出牌组合枚举 ================= */

  /** 挑最省的带牌翅膀 */
  function cheapestWings(g, exclude, size, count) {
    var ex = {};
    for (var i = 0; i < exclude.length; i++) ex[exclude[i]] = true;
    var pool = [];
    g.forEach(function (arr, rk) {
      if (ex[rk]) return;
      if (arr.length >= 4) return;            // 不拆炸弹
      if (arr.length < size) return;
      if (rk >= 16 && size === 2) return;     // 王凑不成对
      pool.push({ rk: rk, cards: arr.slice(0, size) });
    });
    if (pool.length < count) return null;
    pool.sort(function (a, b) { return a.rk - b.rk; });
    var out = [];
    for (var k = 0; k < count; k++) out = out.concat(pool[k].cards);
    return out;
  }

  /** 枚举一手牌所有可作领出的组合（去重） */
  function allLeadCombos(hand) {
    var out = [], seen = new Set();
    function add(cards) {
      if (!cards || !cards.length) return;
      var key = cards.map(function (c) { return c.id; })
        .sort(function (a, b) { return a - b; }).join('-');
      if (seen.has(key)) return;
      var combo = Cards.parse(cards);
      if (!combo) return;
      seen.add(key);
      out.push({ cards: cards, combo: combo });
    }

    var g = Cards.groupByRank(hand);
    var ranks = Array.from(g.keys()).sort(function (a, b) { return a - b; });
    var i, seg;

    ranks.forEach(function (rk) {
      var arr = g.get(rk);
      add([arr[0]]);
      if (arr.length >= 2) add(arr.slice(0, 2));
      if (arr.length >= 3) add(arr.slice(0, 3));
      if (arr.length === 4) add(arr.slice(0, 4));
    });
    if (g.has(16) && g.has(17)) add([g.get(16)[0], g.get(17)[0]]);

    function runsWith(need, minLen, maxLen) {
      var pool = ranks.filter(function (x) { return x <= 14 && g.get(x).length >= need; });
      var res = [];
      var p = 0;
      while (p < pool.length) {
        var q = p;
        while (q + 1 < pool.length && pool[q + 1] - pool[q] === 1) q++;
        var s0 = pool.slice(p, q + 1);
        for (var L = minLen; L <= Math.min(maxLen, s0.length); L++) {
          for (var st = 0; st + L <= s0.length; st++) res.push(s0.slice(st, st + L));
        }
        p = q + 1;
      }
      return res;
    }
    function gather(seg, per) {
      var cs = [];
      for (var x = 0; x < seg.length; x++) cs = cs.concat(g.get(seg[x]).slice(0, per));
      return cs;
    }

    runsWith(1, 5, 12).forEach(function (s) { add(gather(s, 1)); });
    runsWith(2, 3, 10).forEach(function (s) { add(gather(s, 2)); });
    runsWith(3, 2, 6).forEach(function (s) {
      add(gather(s, 3));
      var w1 = cheapestWings(g, s, 1, s.length);
      if (w1) add(gather(s, 3).concat(w1));
      var w2 = cheapestWings(g, s, 2, s.length);
      if (w2) add(gather(s, 3).concat(w2));
    });

    ranks.filter(function (rk) { return g.get(rk).length >= 3; }).forEach(function (rk) {
      var tri = g.get(rk).slice(0, 3);
      var w1 = cheapestWings(g, [rk], 1, 1);
      if (w1) add(tri.concat(w1));
      var w2 = cheapestWings(g, [rk], 2, 1);
      if (w2) add(tri.concat(w2));
    });
    ranks.filter(function (rk) { return g.get(rk).length === 4; }).forEach(function (rk) {
      var quad = g.get(rk).slice(0, 4);
      var w1 = cheapestWings(g, [rk], 1, 2);
      if (w1) add(quad.concat(w1));
      var w2 = cheapestWings(g, [rk], 2, 2);
      if (w2) add(quad.concat(w2));
    });

    return out;
  }

  /* ---------------- 手牌强度评估（叫分 / 加倍） ---------------- */

  function bidScore(hand) {
    var c = Cards.rankCounts(hand);
    var s = 0;
    var r;

    if (c[17]) s += 6;
    if (c[16]) s += 4;
    if (c[16] && c[17]) s += 3;
    s += (c[15] || 0) * 2.5;
    s += (c[14] || 0) * 1.2;

    for (r = 3; r <= 15; r++) if (c[r] === 4) s += 7;

    var dec = Dec.decompose(hand);
    var hands = dec.hands;
    for (var i = 0; i < hands.length; i++) {
      var cb = Cards.parse(hands[i]);
      if (!cb) continue;
      if (cb.type === CT.STRAIGHT && cb.len >= 5) s += 1.6 + (cb.len - 5) * 0.5;
      else if (cb.type === CT.DOUBLE_STRAIGHT) s += 1.8;
      else if (cb.type === CT.TRIPLE_STRAIGHT || cb.type === CT.AIRPLANE_ONE ||
        cb.type === CT.AIRPLANE_PAIR) s += 2.0;
      else if (cb.type === CT.BOMB) s += 4;
      else if (cb.type === CT.ROCKET) s += 6;
      else if (cb.type === CT.TRIPLE) s += 0.8;
      else if (cb.type === CT.TRIPLE_ONE || cb.type === CT.TRIPLE_PAIR) s += 1.0;
    }

    if (dec.count <= 4) s += 4.5;
    else if (dec.count <= 5) s += 2.5;
    else if (dec.count <= 6) s += 1.0;
    else if (dec.count >= 9) s -= 2.5;

    var singles = 0;
    for (r = 3; r <= 15; r++) if (c[r] === 1) singles++;
    s -= singles * 0.75;

    return s;
  }

  /* ---------------- 叫地主 ---------------- */

  function decideBid(hand, ctx) {
    ctx = ctx || {};
    var cfg = CFG[ctx.difficulty] || CFG.normal;
    var s = bidScore(hand) + cfg.bidBias;
    if (cfg.bidNoise) s += (Math.random() * 2 - 1) * cfg.bidNoise;

    var maxBid = ctx.maxBidSoFar || 0;
    var want;
    if (s >= 13) want = 3;
    else if (s >= 9.5) want = 2;
    else if (s >= 6.5) want = 1;
    else want = 0;

    if (want <= maxBid) return 0;
    return want;
  }

  /* ---------------- 加倍 ---------------- */

  function decideDouble(hand, ctx) {
    ctx = ctx || {};
    var cfg = CFG[ctx.difficulty] || CFG.normal;
    var s = bidScore(hand);

    if (ctx.role === 'farmer') {
      if (ctx.difficulty === 'easy') return s > 11 && Math.random() < 0.5 ? 1 : 0;
      if (s >= 14 && cfg.superDouble) return 2;
      if (s >= 9.5) return 1;
      return 0;
    }
    var fd = ctx.farmerDoubled || 0;
    if (ctx.difficulty === 'easy') return 0;
    if (s >= 12 || fd >= 2) return 1;
    return 0;
  }

  /* ================= 摊牌制推演（完美信息蒙特卡洛） =================
   *
   * 启发式调参已经到瓶颈（A/B 实验证实），所以高手档改用真正的推演：
   *   1. 摊牌：把「未出现的牌」随机分配给两个对手，得到一个可能的完整牌局
   *   2. 我先打出候选的一手，然后用快速贪心策略把整局推演到底
   *   3. 统计每个候选的胜率，选胜率最高的
   * 这等价于信息集蒙特卡洛搜索（ISMCTS）的简化版：用「随机摊牌 + 策略推演」
   * 代替搜索树展开，能看见启发式看不见的后续交换与残局走向。
   */

  var fakeIdSeq = 0;
  function makeFake(rank) {
    return { id: ++fakeIdSeq, rank: rank, suit: 0, joker: rank >= 16,
      label: '', red: false, sym: '' };
  }

  /** 按点数计数构造轻量牌对象（parse/findBeats 只依赖 rank/id） */
  function fakeFromCounts(c) {
    var out = [];
    for (var r = 3; r <= 17; r++) {
      for (var i = 0; i < (c[r] || 0); i++) out.push(makeFake(r));
    }
    return out;
  }

  function removeById(cards, drop) {
    var ids = new Set(drop.map(function (c) { return c.id; }));
    return cards.filter(function (c) { return !ids.has(c.id); });
  }

  /** 快速领出策略：贪心拆解的第一手；能一把走完就直接走 */
  function greedyLeadMove(hand) {
    var combo = Cards.parse(hand);
    if (combo) return hand.slice();
    var counts = Cards.rankCounts(hand);
    var path = Dec.greedyPath(counts);
    if (path.length) {
      var g = Cards.groupByRank(hand);
      var out = [];
      for (var r = 0; r < 18; r++) {
        var need = path[0][r] || 0;
        if (need && g.has(r)) out = out.concat(g.get(r).slice(0, need));
      }
      if (out.length && Cards.parse(out)) return out;
    }
    var min = null;
    for (var i = 0; i < hand.length; i++) {
      if (!min || hand[i].rank < min.rank) min = hand[i];
    }
    return min ? [min] : null;
  }

  /** 快速跟牌策略：挑点数和最小的非炸弹；能一把走完直接走；不压队友 */
  function greedyFollowMove(hand, lastCombo, isMatePlay) {
    if (isMatePlay) return null;
    var beats = Cards.findBeats(hand, lastCombo);
    if (!beats.length) return null;
    for (var i = 0; i < beats.length; i++) {
      if (beats[i].length === hand.length) return beats[i];   // 直接获胜
    }
    var best = null, bestP = Infinity;
    for (var j = 0; j < beats.length; j++) {
      var cb = Cards.parse(beats[j]);
      var p = powerOf(beats[j]) +
        ((cb.type === CT.BOMB || cb.type === CT.ROCKET) ? 60 : 0);
      if (p < bestP) { bestP = p; best = beats[j]; }
    }
    return best;
  }

  /** 从贪心拆解路径中取出第 idx 手的实际牌（greedyLeadMove 同款提取） */
  function pathHand(hand, path, idx) {
    var g = Cards.groupByRank(hand);
    var out = [];
    for (var r = 0; r < 18; r++) {
      var need = path[idx][r] || 0;
      if (need && g.has(r)) out = out.concat(g.get(r).slice(0, need));
    }
    return (out.length && Cards.parse(out)) ? out : null;
  }

  /**
   * 残局感知的推演领出策略（FEAT.smartRollout）。
   * greedyLeadMove 完全不看各家剩牌数 —— 地主剩 1 张时照样领小单张送赢，
   * 这是推演偏差的最大来源。这里按推演中可见的手牌数调整：
   * - 农民队友剩 ≤2 张：优先领小单张喂队友
   * - 对手剩 ≤2 张：避免领小单张（改领别的手 / 领最大的单）
   * - 其余情况与贪心一致
   */
  function smartLeadMove(hand, mySeat, hands, roles, landlordSeat) {
    var combo = Cards.parse(hand);
    if (combo) return hand.slice();
    var counts = Cards.rankCounts(hand);
    var path = Dec.greedyPath(counts);
    var g = Cards.groupByRank(hand);

    var mateShort = -1, oppShort = -1;
    for (var s = 0; s < 3; s++) {
      if (s === mySeat) continue;
      var isMate = (roles[mySeat] === 'farmer' && roles[s] === 'farmer');
      var n = hands[s].length;
      if (isMate) { if (mateShort < 0 || n < mateShort) mateShort = n; }
      else { if (oppShort < 0 || n < oppShort) oppShort = n; }
    }

    // 喂队友：队友快走完了，领最小单张
    if (mateShort >= 1 && mateShort <= 2 && roles[mySeat] === 'farmer') {
      var small = null;
      for (var r = 3; r <= 15; r++) {
        if (g.has(r) && g.get(r).length === 1 && (!small || g.get(r)[0].rank < small.rank)) {
          small = g.get(r)[0];
        }
      }
      if (small) return [small];
    }

    // 防对手：对手快走完了，别送小单张
    if (oppShort >= 1 && oppShort <= 2) {
      for (var i = 0; i < path.length; i++) {
        var cnt = 0;
        for (var r2 = 0; r2 < 18; r2++) cnt += path[i][r2] || 0;
        if (cnt !== 1) {
          var out = pathHand(hand, path, i);
          if (out) return out;
        }
      }
      var big = null;
      for (var r3 = 3; r3 <= 17; r3++) {
        if (g.has(r3) && (!big || g.get(r3)[0].rank > big.rank)) big = g.get(r3)[0];
      }
      if (big) return [big];
    }

    if (path.length) {
      var out2 = pathHand(hand, path, 0);
      if (out2) return out2;
    }
    var min = null;
    for (var i2 = 0; i2 < hand.length; i2++) {
      if (!min || hand[i2].rank < min.rank) min = hand[i2];
    }
    return min ? [min] : null;
  }

  /**
   * 残局感知的推演跟牌策略：领出者是对手且剩 ≤2 张时，
   * 解除炸弹罚（危局下炸弹该炸就炸）；其余与贪心一致。
   */
  function smartFollowMove(hand, lastCombo, mySeat, lastSeat, hands, roles, landlordSeat) {
    var role = roles[mySeat];
    var teammate = (role === 'farmer') ? (3 - mySeat - landlordSeat + 3) % 3 : -1;
    var isMate = (role === 'farmer' && lastSeat === teammate);
    if (isMate) return null;
    var beats = Cards.findBeats(hand, lastCombo);
    if (!beats.length) return null;
    for (var i = 0; i < beats.length; i++) {
      if (beats[i].length === hand.length) return beats[i];
    }
    var oppShort = hands[lastSeat] ? hands[lastSeat].length <= 2 : false;
    var best = null, bestP = Infinity;
    for (var j = 0; j < beats.length; j++) {
      var cb = Cards.parse(beats[j]);
      var bomb = (cb.type === CT.BOMB || cb.type === CT.ROCKET);
      var p = powerOf(beats[j]) + (bomb && !oppShort ? 60 : 0);
      if (p < bestP) { bestP = p; best = beats[j]; }
    }
    return best;
  }

  /**
   * 把整局推演到底，返回赢家座位；-2 表示超时未分胜负。
   * hands 会被原地修改，调用方需传入副本。
   */
  function rollout(hands, turn, lastCombo, lastSeat, roles, landlordSeat, budget, useSmart) {
    var passCount = 0;
    for (var ply = 0; ply < 220; ply++) {
      if (budget && budget.n-- <= 0) return -2;
      if (lastCombo && lastSeat === turn) { lastCombo = null; passCount = 0; }
      var hand = hands[turn];
      if (!hand.length) return turn;

      var role = roles[turn];
      var teammate = (role === 'farmer') ? (3 - turn - landlordSeat + 3) % 3 : -1;
      var move;
      if (useSmart) {
        if (!lastCombo) {
          move = smartLeadMove(hand, turn, hands, roles, landlordSeat);
        } else {
          move = smartFollowMove(hand, lastCombo, turn, lastSeat, hands, roles, landlordSeat);
        }
      } else if (!lastCombo) {
        move = greedyLeadMove(hand);
      } else {
        var isMate = (role === 'farmer' && lastSeat === teammate);
        move = greedyFollowMove(hand, lastCombo, isMate);
      }

      if (move && move.length) {
        var combo = Cards.parse(move);
        if (!combo) return -2;
        hands[turn] = removeById(hand, move);
        lastCombo = combo; lastSeat = turn; passCount = 0;
        if (!hands[turn].length) return turn;
      } else {
        passCount++;
        if (lastCombo && passCount >= 2) { lastCombo = null; passCount = 0; }
      }
      turn = (turn + 1) % 3;
    }
    return -2;
  }

  /** 摊牌：把未出现的牌随机分给两个对手，构造一个可能的完整牌局 */
  function determinize(mySeat, myHand, counts, uc, realHands) {
    if (realHands) {
      return [realHands[0].slice(), realHands[1].slice(), realHands[2].slice()];
    }
    var pool = fakeFromCounts(uc);
    Cards.shuffle(pool);
    var hands = [[], [], []];
    hands[mySeat] = myHand.slice();
    var idx = 0;
    for (var s = 0; s < 3; s++) {
      if (s === mySeat) continue;
      var n = counts[s];
      hands[s] = pool.slice(idx, idx + n);
      idx += n;
    }
    return hands;
  }

  /** 是否进入残局（各家剩余牌都不多） */
  function inEndgame(counts) {
    var mx = 0;
    for (var i = 0; i < counts.length; i++) if (counts[i] > mx) mx = counts[i];
    return mx <= (FEAT.endgameN || 9);
  }

  /**
   * 是否该启用推演：默认只在残局。
   * 早期牌多时推演回合长、采样噪声大，且「后续按简陋策略续打」的偏差会被放大 ——
   * A/B 实测早期启用推演反而明显掉分，因此只在牌少的局面使用。
   * FEAT.rolloutAlways 可强制全程启用（仅用于实验对比）。
   */
  function useRolloutHere(ctx) {
    if (FEAT.rolloutAlways) return true;
    // 大师档信息完全，残局推演可以更早开始（阈值放宽到 15），
    // 但中盘依然不开 —— A/B 实测中盘推演无论信息是否完全都会掉分
    if (ctx.perfectInfo) {
      var mx = 0;
      for (var i = 0; i < ctx.counts.length; i++) if (ctx.counts[i] > mx) mx = ctx.counts[i];
      return mx <= 15;
    }
    return inEndgame(ctx.counts);
  }

  /**
   * PIMC 是否负责本次决策：大师档完全信息残局，精确求解器全面接管时，
   * 需要跳过 winSolver / 两手残局等预拦截，让求解器在完整候选集上定夺。
   */
  function pimcHandles(ctx) {
    if (!FEAT.pimc || !ctx.perfectInfo) return false;
    var mx = 0, total = 0;
    for (var i = 0; i < ctx.counts.length; i++) {
      if (ctx.counts[i] > mx) mx = ctx.counts[i];
      total += ctx.counts[i];
    }
    // 复杂度主要由总牌数决定：mx 略超但总量小（如 15/4/5）照样可精确求解
    return mx <= (FEAT.pimcMax || 12) || total <= (FEAT.pimcTotalMax || 24);
  }

  /**
   * 用推演评估各候选，返回胜率最高的那个。
   * options: [{ cards, combo }] 或 [{ pass: true }]
   * 返回选中的 option；全都被推演否决时返回 null（跟牌时可理解为不要）。
   */
  function decideByRollout(ctx, options) {
    // PIMC：仅高难度档启用精确求解；完全信息（大师）只需 1 个世界，
    // 隐藏信息时用少量世界摊牌（每个世界内是精确解，噪声远小于策略推演）
    var usePimc = FEAT.pimc &&
      (ctx.difficulty === 'hard' || ctx.difficulty === 'master' || ctx.perfectInfo);
    var mx = 0, total = 0;
    for (var ci = 0; ci < ctx.counts.length; ci++) {
      if (ctx.counts[ci] > mx) mx = ctx.counts[ci];
      total += ctx.counts[ci];
    }
    var pimcMax = ctx.perfectInfo ? (FEAT.pimcMax || 12) : 8;
    var pimcTotalMax = ctx.perfectInfo ? (FEAT.pimcTotalMax || 24) : 16;
    if (usePimc && !(mx <= pimcMax || total <= pimcTotalMax)) usePimc = false;   // 状态空间爆炸，交回推演

    var K;
    if (usePimc) K = ctx.perfectInfo ? 1 : 4;
    else if (ctx.perfectInfo) K = (FEAT.rolloutKMaster || 60);
    else K = inEndgame(ctx.counts) ? (FEAT.rolloutK || 34) : 12;
    // 大师档放宽推演预算（用户允许最长 3 秒思考）；其余档维持原预算
    var budget = { n: ctx.perfectInfo ? (FEAT.masterBudget || 14000) : 14000 };
    // PIMC 总预算按决策计；单次求解再设上限防止个别爆炸局面吃光预算
    var pimcTotal = { n: FEAT.pimcBudget || 1200000 };
    var solveCap = ctx.perfectInfo ? (FEAT.pimcSolveCap || 200000)
      : Math.min(FEAT.pimcSolveCap || 200000, 100000);
    var mySeat = ctx.seat;
    var landlordSeat = ctx.landlordSeat;
    var roles = [0, 1, 2].map(function (s) {
      return s === landlordSeat ? 'landlord' : 'farmer';
    });
    var myRole = roles[mySeat];
    var teammateSeat = (myRole === 'farmer') ? (3 - mySeat - landlordSeat + 3) % 3 : -1;
    // 残局感知续打只给高难度档用（发布形态），普通档保持原策略 ——
    // 这样 duel.js 配对测量时单侧收益才可测
    var useSmart = FEAT.smartRollout &&
      (ctx.difficulty === 'hard' || ctx.difficulty === 'master' || ctx.perfectInfo);

    function winRate(opt) {
      var wins = 0, games = 0;
      for (var k = 0; k < K; k++) {
        if (budget.n <= 0) break;
        var hands = determinize(mySeat, ctx.hand, ctx.counts, ctx.unseen, ctx.hands);
        var turn = (mySeat + 1) % 3;
        var lastCombo = ctx.lastCombo, lastSeat = ctx.lastSeat;

        if (opt.pass) {
          // 什么都不出，直接轮到下家
        } else {
          var ids = new Set(opt.cards.map(function (c) { return c.id; }));
          hands[mySeat] = removeById(hands[mySeat], opt.cards);
          if (!hands[mySeat].length) return 1;        // 打完直接获胜
          lastCombo = Cards.parse(opt.cards);
          if (!lastCombo) continue;
          lastSeat = mySeat;
        }

        var iWin;
        if (usePimc) {
          if (pimcTotal.n <= 0) continue;
          if (API.PIMC_STATS) { API.PIMC_STATS.solves++; }
          var allow = Math.min(solveCap, pimcTotal.n);
          var sb = { n: allow };
          var r = solveEndgame(hands, turn, lastCombo, lastSeat, landlordSeat, sb);
          pimcTotal.n -= (allow - sb.n);            // 扣掉实际消耗的节点
          if (API.PIMC_STATS) { API.PIMC_STATS.nodes += (allow - sb.n); }
          if (r === null) continue;                   // 预算耗尽，这个世界不计入
          iWin = (myRole === 'landlord') ? (r === 1) : (r === 0);
          games++; wins += iWin ? 1 : 0;
          continue;
        }
        var w = rollout(hands, turn, lastCombo, lastSeat, roles, landlordSeat, budget, useSmart);
        if (w < 0) continue;                          // 没推完，不计入
        games++;
        iWin = (myRole === 'landlord') ? (w === landlordSeat) : (w !== landlordSeat);
        if (iWin) wins++;
      }
      return games ? wins / games : -1;               // -1 = 数据不足
    }

    var best = null, bestScore = -1;
    var anyWin = false;
    for (var i = 0; i < options.length; i++) {
      var r = winRate(options[i]);
      if (r < 0) continue;
      if (r > 0) anyWin = true;
      // 同胜率时偏向不被动出大牌：给一点点「代价」惩罚做平票决断
      var score = r - (options[i].pass ? 0 : powerOf(options[i].cards) / 400);
      if (score > bestScore) { bestScore = score; best = options[i]; }
    }
    // 一个胜局都推不出来时，说明当前策略视角下没有好棋 ——
    // 交回启发式决策，绝不能退化成「随便出一张最小的」
    return anyWin ? best : null;
  }

  /* ---------------- 领出候选（提示 / 新手档也用） ---------------- */

  function leadCandidates(hand) {
    var out = [];
    var seen = new Set();
    function add(cards) {
      if (!cards || !cards.length) return;
      var key = cards.map(function (c) { return c.id; })
        .sort(function (a, b) { return a - b; }).join('-');
      if (seen.has(key)) return;
      seen.add(key);
      var combo = Cards.parse(cards);
      if (combo) out.push({ cards: cards, combo: combo });
    }

    var dec = Dec.decompose(hand);
    for (var i = 0; i < dec.hands.length; i++) add(dec.hands[i]);

    var g = Cards.groupByRank(hand);
    var ranks = Array.from(g.keys()).sort(function (a, b) { return a - b; });
    for (var k = 0; k < ranks.length; k++) add([g.get(ranks[k])[0]]);
    var pairs = ranks.filter(function (r) { return g.get(r).length >= 2; }).slice(0, 6);
    for (var p = 0; p < pairs.length; p++) add(g.get(pairs[p]).slice(0, 2));
    var trips = ranks.filter(function (r) { return g.get(r).length >= 3; }).slice(0, 4);
    for (var t = 0; t < trips.length; t++) add(g.get(trips[t]).slice(0, 3));

    return out.slice(0, 16);
  }

  /* ---------------- 领出 ---------------- */

  function decideLead(ctx) {
    var hand = ctx.hand;
    var cfg = CFG[ctx.difficulty] || CFG.normal;
    var uc = cfg.useUnseen ? ctx.unseen : null;
    var dec = Dec.decompose(hand);

    /* --- 能一把走完，直接赢 --- */
    var oneShot = Cards.parse(hand);
    if (oneShot) return { cards: Cards.sortAsc(hand.slice()), combo: oneShot, tag: 'win' };

    /* --- easy：随手出张最小的，别把炸弹拆了 --- */
    if (ctx.difficulty === 'easy') {
      var candsE = leadCandidates(hand).filter(function (x) {
        return x.combo.type !== CT.BOMB && x.combo.type !== CT.ROCKET;
      });
      candsE.sort(function (a, b) {
        var pa = powerOf(a.cards) / a.cards.length, pb = powerOf(b.cards) / b.cards.length;
        return pa - pb;
      });
      if (!candsE.length) {
        var fb = hand[hand.length - 1];
        return { cards: [fb], combo: Cards.parse([fb]), tag: 'fallback' };
      }
      var pickIdx = Math.random() < 0.7 ? 0 : Math.min(1, candsE.length - 1);
      return { cards: Cards.sortAsc(candsE[pickIdx].cards.slice()), combo: candsE[pickIdx].combo, tag: 'easy' };
    }

    /* --- 必胜链：每一手都让对手压不起，直接照着打 --- */
    if (uc && FEAT.forcedWin && !pimcHandles(ctx)) {
      var solver = winSolver(uc, ctx.oppCounts ? function (cb) { return oppCanBeat(ctx.oppCounts, cb); } : null);
      var wc = leadCandidates(hand);
      var w = solver.pick(hand, wc);
      if (w) return { cards: Cards.sortAsc(w.cards.slice()), combo: w.combo, tag: 'forced-win' };
    }

    /* --- PIMC 接管：完全信息残局交给精确求解器在完整候选集上定夺 --- */
    if (uc && pimcHandles(ctx)) {
      var pOpts = leadCandidates(hand);
      var pPick = decideByRollout(ctx, pOpts);
      if (pPick) return { cards: Cards.sortAsc(pPick.cards.slice()), combo: pPick.combo, tag: 'pimc' };
    }

    /* --- 只剩两手：先打最不容易被压住的那一手 --- */
    if (dec.hands.length === 2) {
      var h0 = Cards.parse(dec.hands[0]), h1 = Cards.parse(dec.hands[1]);
      var oppMin = 20;
      for (var s = 0; s < ctx.counts.length; s++) {
        if (s === ctx.seat) continue;
        if (ctx.counts[s] < oppMin) oppMin = ctx.counts[s];
      }
      var bomb0 = (h0 && (h0.type === CT.BOMB || h0.type === CT.ROCKET));
      var bomb1 = (h1 && (h1.type === CT.BOMB || h1.type === CT.ROCKET));
      var first;
      if (uc) {
        // 谁是对手压不起的，先打谁 —— 打出去还能接着出
        var safe0 = !unseenHasBeat(uc, h0), safe1 = !unseenHasBeat(uc, h1);
        if (safe0 !== safe1) first = safe0 ? 0 : 1;
        else if (bomb0 !== bomb1) first = (oppMin <= 3) ? (bomb0 ? 0 : 1) : (bomb0 ? 1 : 0);
        else first = (h0.main >= h1.main) ? 0 : 1;
      } else if (bomb0 !== bomb1) {
        first = (oppMin <= 3) ? (bomb0 ? 0 : 1) : (bomb0 ? 1 : 0);
      } else {
        first = (h0.main >= h1.main) ? 0 : 1;
      }
      return {
        cards: Cards.sortAsc(dec.hands[first].slice()),
        combo: Cards.parse(dec.hands[first]), tag: 'two-hands'
      };
    }

    /* --- 通用评估 --- */
    var cands = leadCandidates(hand);
    var best = null, bestScore = Infinity;
    var scored = [];
    for (var i = 0; i < cands.length; i++) {
      var cd = cands[i];
      var rest = Dec.removeCards(hand, cd.cards);
      var newHands = rest.length ? Dec.minHands(rest, 'quick') : 0;
      var safe = uc && !canOppBeat(ctx, uc, cd.combo);   // 打出去必然保住先手
      var isBomb = cd.combo.type === CT.BOMB || cd.combo.type === CT.ROCKET;

      var score = newHands * 10 + powerOf(cd.cards);
      if (isBomb) score += cfg.leadBombPenalty;
      if (cd.combo.type === CT.STRAIGHT || cd.combo.type === CT.DOUBLE_STRAIGHT ||
        cd.combo.type === CT.TRIPLE_STRAIGHT) score -= 2.5;

      /* 逃牌封堵：对手剩余张数恰好等于这手牌的张数时，
         他若正好握着更大的同型牌就能直接走完 —— 高度危险 */
      var useEscape = FEAT.escapeBlock;
      var useSafe = FEAT.safeBonus;
      if (safe && useSafe) { score -= 10; if (newHands <= 2) score -= 6; }
      if (uc && useEscape && !safe) {
        for (var o = 0; o < ctx.counts.length; o++) {
          if (!isEnemySeat(ctx, o)) continue;   // 队友快走完是好事，不是威胁
          var left = ctx.counts[o];
          if (left === cd.cards.length) score += 30;
          else if (left === 1 && cd.combo.type === CT.SINGLE) score += 55;
          else if (left === 2 && cd.combo.type === CT.PAIR) score += 55;
        }
      }
      // 不用记牌时的常识版：对手只剩 1 张时别送小单张
      if (!uc && cd.combo.type === CT.SINGLE && cd.combo.main <= 9) {
        for (var o2 = 0; o2 < ctx.counts.length; o2++) {
          if (o2 !== ctx.seat && ctx.counts[o2] === 1) score += 25;
        }
      }

      // 农民配合：队友快走完了，出小单张送他
      if (cfg.teammateHelp && ctx.role === 'farmer' && ctx.teammateSeat !== undefined) {
        var tmCount = ctx.counts[ctx.teammateSeat];
        if (tmCount <= 2 && cd.combo.type === CT.SINGLE && cd.combo.main <= 10) score -= 14;
      }

      // 农民定位配合（经典打法，仅高手档）：
      //   上家（我出完就轮到地主）→ 放小喂队友、攒大牌，别把王牌浪费在探路上
      //   下家（地主出完就轮到我）→ 顶牌耗地主，别送小单张让地主轻松过牌
      if (FEAT.position && ctx.role === 'farmer' && ctx.landlordSeat !== undefined) {
        var iAmUpper = (ctx.landlordSeat === (ctx.seat + 1) % 3);
        if (iAmUpper) {
          if (cd.combo.type === CT.SINGLE && cd.combo.main <= 8) score -= 5;
          if (cd.combo.main >= 15) score += 7;                    // 2 和王留着自己控场
        } else {
          if (cd.combo.type === CT.SINGLE && cd.combo.main <= 9) score += 7;
          if (cd.combo.main >= 14) score -= 4;                    // 下家该顶
        }
      }

      if (score < bestScore) { bestScore = score; best = cd; }
      scored.push({ cd: cd, score: score });
    }

    /* --- 高手档：用摊牌推演从启发式前几名里选，看见后续交换 --- */
    if (uc && FEAT.rollout && scored.length && useRolloutHere(ctx)) {
      scored.sort(function (a, b) { return a.score - b.score; });
      var top = scored.slice(0, 6).map(function (x) { return x.cd; });
      var pick = decideByRollout(ctx, top);
      if (pick) {
        return { cards: Cards.sortAsc(pick.cards.slice()), combo: pick.combo, tag: 'rollout' };
      }
    }

    if (!best) {
      var fb2 = hand[hand.length - 1];
      return { cards: [fb2], combo: Cards.parse([fb2]), tag: 'fallback' };
    }
    return { cards: Cards.sortAsc(best.cards.slice()), combo: best.combo, tag: 'lead' };
  }

  /* ---------------- 跟牌 ---------------- */

  function decideFollow(ctx) {
    var hand = ctx.hand;
    var cfg = CFG[ctx.difficulty] || CFG.normal;
    var uc = cfg.useUnseen ? ctx.unseen : null;
    var list = Cards.findBeats(hand, ctx.lastCombo);
    if (!list.length) return null;

    var cands = [];
    var seen = new Set();
    for (var i = 0; i < list.length; i++) {
      var key = list[i].map(function (c) { return c.id; })
        .sort(function (a, b) { return a - b; }).join('-');
      if (seen.has(key)) continue;
      seen.add(key);
      var combo = Cards.parse(list[i]);
      if (!combo) continue;
      cands.push({ cards: list[i], combo: combo });
    }
    if (!cands.length) return null;

    var lastSeat = ctx.lastSeat;
    var isTeammate = (ctx.role === 'farmer' && ctx.teammateSeat === lastSeat);

    /* --- 能一把打完：立即获胜 --- */
    for (var w = 0; w < cands.length; w++) {
      if (cands[w].cards.length === hand.length) {
        return { cards: Cards.sortAsc(cands[w].cards.slice()), combo: cands[w].combo, tag: 'win' };
      }
    }

    /* --- easy：多数时候直接不要，出牌只挑最小的 ---
     * 唯一例外：出牌方是敌方且只剩 ≤2 张（即将跑掉）——此时新手也
     * 会用最小的能压牌拦一下，随机不要会让新手场失去对局感
     * （此前提交只修了领出兜底路径，跟牌路径漏网） */
    if (ctx.difficulty === 'easy') {
      var escape = (ctx.counts[lastSeat] <= 2 && !isTeammate);
      if (!escape && Math.random() < cfg.passChance) return null;
      var nonBomb = cands.filter(function (x) {
        return x.combo.type !== CT.BOMB && x.combo.type !== CT.ROCKET;
      });
      // 拦截优先用非炸弹的最小能压牌；只有炸弹能压时才动用——
      // 拦下即将逃跑的敌人值得一颗炸弹，但持 2 可拦时炸出去是浪费
      var pool = escape ? (nonBomb.length ? nonBomb : cands) : nonBomb;
      if (!pool.length) return null;
      pool.sort(function (a, b) { return powerOf(a.cards) - powerOf(b.cards); });
      return { cards: Cards.sortAsc(pool[0].cards.slice()), combo: pool[0].combo, tag: 'easy' };
    }

    /* --- 队友出的牌：不压，把机会留给他 --- */
    if (isTeammate) {
      var tmLeft = ctx.counts[lastSeat];
      if (tmLeft <= 2) return null;
      var restAll = Dec.minHands(hand);
      if (!(restAll <= 2 && ctx.difficulty === 'hard')) return null;
    }

    /* --- 必胜链：压住这一手之后能一路打完，直接走 --- */
    if (uc && FEAT.forcedWin && !pimcHandles(ctx)) {
      var solver = winSolver(uc, ctx.oppCounts ? function (cb) { return oppCanBeat(ctx.oppCounts, cb); } : null);
      for (var wi = 0; wi < cands.length; wi++) {
        var wcd = cands[wi];
        if (unseenHasBeat(uc, wcd.combo)) continue;   // 压不住下一轮就没意义
        var wrest = Dec.removeCards(hand, wcd.cards);
        if (!wrest.length) continue;
        if (solver.exists(wrest)) {
          return { cards: Cards.sortAsc(wcd.cards.slice()), combo: wcd.combo, tag: 'forced-win' };
        }
        if (solver.exhausted()) break;
      }
    }

    /* --- PIMC 接管：完全信息残局交给精确求解器在完整候选集上定夺 --- */
    if (uc && pimcHandles(ctx)) {
      var pFOpts = cands.slice();
      pFOpts.push({ pass: true });
      var pFPick = decideByRollout(ctx, pFOpts);
      if (pFPick) {
        if (pFPick.pass) return null;
        return { cards: Cards.sortAsc(pFPick.cards.slice()), combo: pFPick.combo, tag: 'pimc' };
      }
      return null;   // 求解器否决所有压牌 → 不要
    }

    var enemyLeft = ctx.counts[lastSeat];
    var myHands = Dec.minHands(hand);
    var wantLead = myHands <= 4 ? 8 : (myHands <= 6 ? 3 : 0);

    var threat;
    if (enemyLeft <= 1) threat = 150;
    else if (enemyLeft <= 2) threat = 50;
    else if (enemyLeft <= 4) threat = 16;
    else if (enemyLeft <= 7) threat = 6;
    else threat = 2;

    // 队友快走完时，把处理权交给队友
    if (cfg.teammateHelp && ctx.role === 'farmer' && ctx.teammateSeat !== undefined &&
      !isTeammate && ctx.counts[ctx.teammateSeat] <= 2 && enemyLeft > 3) {
      threat *= 0.35;
    }

    // 对手只剩一两张时，这一手不压他就极可能直接跑掉 —— 必须拦
    var mustBlock = FEAT.mustBlock && (enemyLeft <= 2);

    var best = null, bestScore = Infinity;
    var fScored = [];
    for (var c = 0; c < cands.length; c++) {
      var cd = cands[c];
      var rest = Dec.removeCards(hand, cd.cards);
      var newHands = rest.length ? Dec.minHands(rest, 'quick') : 0;
      var structLoss = newHands - myHands;

      var isBomb = cd.combo.type === CT.BOMB || cd.combo.type === CT.ROCKET;
      var holdsLead = uc && !canOppBeat(ctx, uc, cd.combo);   // 打出去后对手压不起

      var cost = structLoss * 14 + powerOf(cd.cards);
      for (var k = 0; k < cd.cards.length; k++) {
        if (cd.cards[k].rank >= 15) cost += 3;
      }
      if (isBomb) cost += cfg.bombPenalty;

      var benefit = threat + wantLead;
      if (holdsLead && FEAT.holdsLead) benefit += (newHands <= 3 ? 13 : 4.5);
      if (ctx.role === 'landlord') benefit += 1.5;

      // 定位配合：下家该顶，上家省牌（除非局势危急）
      if (FEAT.position && ctx.role === 'farmer' && ctx.landlordSeat !== undefined) {
        var iAmLower = (ctx.landlordSeat === (ctx.seat + 2) % 3);
        if (iAmLower) benefit += 3.5;
        else if (threat < 40) benefit -= 3.5;
      }

      var score = cost - benefit;
      if (mustBlock && FEAT.mustBlock) score -= 25;      // 拦截优先级大幅提高

      if (score < bestScore) { bestScore = score; best = cd; }
      fScored.push({ cd: cd, score: score });
    }

    /* --- 高手档：连同「不要」一起推演，选胜率最高的走法 --- */
    if (uc && FEAT.rollout && fScored.length && useRolloutHere(ctx)) {
      fScored.sort(function (a, b) { return a.score - b.score; });
      var options = fScored.slice(0, 5).map(function (x) { return x.cd; });
      options.push({ pass: true });          // 「不要」也是一个候选
      var pick = decideByRollout(ctx, options);
      if (pick) {
        if (pick.pass) return null;          // 推演认为不要更好
        return { cards: Cards.sortAsc(pick.cards.slice()), combo: pick.combo, tag: 'rollout' };
      }
    }

    if (!best) return null;
    if (bestScore > (FEAT.passBias || 0) && !mustBlock) return null;
    return { cards: Cards.sortAsc(best.cards.slice()), combo: best.combo, tag: 'follow' };
  }

  /* ---------------- 统一入口 ---------------- */

  function decidePlay(ctx) {
    var cfg = CFG[ctx.difficulty] || CFG.normal;
    // 完全信息开关：只有大师档且调用方确实传入了真实手牌时才生效
    ctx.perfectInfo = !!cfg.perfectInfo && !!ctx.hands;
    var unseen;
    if (ctx.hands) {
      // 完全信息（大师档）：对手手牌已知，记牌是精确的而非推算的
      unseen = new Array(18).fill(0);
      for (var s = 0; s < 3; s++) {
        if (s === ctx.seat) continue;
        var hh = ctx.hands[s];
        for (var i = 0; i < hh.length; i++) unseen[hh[i].rank]++;
      }
      ctx.oppCounts = [];
      for (var s2 = 0; s2 < 3; s2++) {
        if (s2 === ctx.seat) continue;
        var oc = new Array(18).fill(0);
        var h2 = ctx.hands[s2];
        for (var i2 = 0; i2 < h2.length; i2++) oc[h2[i2].rank]++;
        ctx.oppCounts.push(oc);
      }
    } else {
      unseen = unseenCounts(ctx.hand, ctx.played);
    }
    ctx.unseen = unseen;
    if (!ctx.lastCombo) return decideLead(ctx);
    return decideFollow(ctx);
  }

  /* ---------------- 玩家出牌提示 ---------------- */

  function hintCandidates(hand, lastCombo) {
    var out = [];
    if (lastCombo) {
      var list = Cards.findBeats(hand, lastCombo);
      var seen = new Set();
      for (var i = 0; i < list.length; i++) {
        var key = list[i].map(function (c) { return c.id; })
          .sort(function (a, b) { return a - b; }).join('-');
        if (seen.has(key)) continue;
        seen.add(key);
        if (!Cards.parse(list[i])) continue;   // 双保险：过滤非法组合（如双王翅膀）
        out.push(list[i]);
      }
      out.sort(function (a, b) {
        var pa = powerOf(a), pb = powerOf(b);
        if (pa !== pb) return pa - pb;
        return a.length - b.length;
      });
      return out;
    }
    var dec = Dec.decompose(hand);
    for (var d = 0; d < dec.hands.length; d++) out.push(dec.hands[d]);
    var g = Cards.groupByRank(hand);
    var ranks = Array.from(g.keys()).sort(function (a, b) { return a - b; });
    var seen2 = new Set(out.map(function (x) {
      return x.map(function (c) { return c.id; }).join('-');
    }));
    for (var r = 0; r < ranks.length; r++) {
      var arr = g.get(ranks[r]);
      var cand = [arr[0]];
      var key2 = cand.map(function (c) { return c.id; }).join('-');
      if (!seen2.has(key2)) { seen2.add(key2); out.push(cand); }
      if (arr.length >= 2) {
        var cand2 = arr.slice(0, 2);
        var key3 = cand2.map(function (c) { return c.id; }).join('-');
        if (!seen2.has(key3)) { seen2.add(key3); out.push(cand2); }
      }
    }
    return out;
  }

  /* ---------------- 导出 ---------------- */
  var API = {
    CFG: CFG, POWER: POWER, FEAT: FEAT,
    PIMC_STATS: { solves: 0, nodes: 0 },   // 诊断计数（pimc 分支累加）
    powerOf: powerOf,
    bidScore: bidScore,
    unseenCounts: unseenCounts,
    unseenHasBeat: unseenHasBeat,
    isBoss: isBoss,
    allLeadCombos: allLeadCombos,
    winSolver: winSolver,
    solveEndgame: solveEndgame,
    decideBid: decideBid,
    decideDouble: decideDouble,
    decideLead: decideLead,
    decideFollow: decideFollow,
    decidePlay: decidePlay,
    hintCandidates: hintCandidates
  };

  if (isNode) module.exports = API;
  else global.AI = API;

})(typeof window !== 'undefined' ? window : globalThis);
