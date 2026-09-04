/* 斗地主&麻将 · 棋牌合集 —— 纯前端单机游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * mj/rules.js —— 麻将规则引擎：胡牌判定 / 向听数 / 进张数 / 番种评定
 * 纯逻辑模块，不依赖 DOM，可在 Node 中直接 require 做单元测试。
 *
 * 约定：
 *   counts —— 长度 34 的张数表（万 0-8 / 条 9-17 / 筒 18-26 / 字 27-33）
 *   meldBudget —— 副露后还需要的面子数（4 − 已副露面子数）；门清时为 4
 *   吃碰杠等副露不计入 counts，只影响 meldBudget
 * ========================================================================== */
(function (global) {
  'use strict';

  var Tiles = global.MjTiles ||
    (typeof require !== 'undefined' ? require('./tiles.js') : null);
  var isHonor = Tiles.isHonor, isTerminal = Tiles.isTerminal;

  /* ---------------- 胡牌判定 ---------------- */

  /** counts（14−3k 张）能否全部拆成 meldBudget 个面子 + 1 个雀头 */
  function canFormMelds(c, meldBudget) {
    var i = 0;
    while (i < 34 && c[i] === 0) i++;
    if (i >= 34) return meldBudget === 0;
    if (meldBudget <= 0) return false;

    // 刻子
    if (c[i] >= 3) {
      c[i] -= 3;
      var ok = canFormMelds(c, meldBudget - 1);
      c[i] += 3;
      if (ok) return true;
    }
    // 顺子（仅数牌，且不越界）
    if (i < 27 && (i % 9) <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
      c[i]--; c[i + 1]--; c[i + 2]--;
      var ok2 = canFormMelds(c, meldBudget - 1);
      c[i]++; c[i + 1]++; c[i + 2]++;
      if (ok2) return true;
    }
    return false;
  }

  /** counts 恰为 7 个对子（普通七对，四张相同按两对计） */
  function isChiitoi(c) {
    var pairs = 0;
    for (var i = 0; i < 34; i++) {
      if (c[i] % 2 !== 0) return false;
      pairs += c[i] / 2;
    }
    return pairs === 7;
  }

  /** 国士无双：幺九字每种至少一张 + 其中一种成对 */
  function isKokushi(c) {
    var kinds = 0, hasPair = false;
    for (var i = 0; i < 34; i++) {
      if (!isHonor(i) && !isTerminal(i)) { if (c[i] > 0) return false; continue; }
      if (c[i] > 0) kinds++;
      if (c[i] >= 2) hasPair = true;
    }
    return kinds === 13 && hasPair;
  }

  /** 是否和牌。draw 是刚摸/刚被打出的那张（含在 counts 里） */
  function isWin(counts, meldBudget) {
    // 门清才有七对 / 国士
    if (meldBudget === 4) {
      if (isChiitoi(counts)) return true;
      if (isKokushi(counts)) return true;
    }
    for (var t = 0; t < 34; t++) {
      if (counts[t] < 2) continue;
      counts[t] -= 2;
      var ok = canFormMelds(counts, meldBudget);
      counts[t] += 2;
      if (ok) return true;
    }
    return false;
  }

  /* ---------------- 向听数 ---------------- */

  /**
   * 七对向听：6 − 对子数 + max(0, 7 − 种类数)
   * 国士向听：13 − 种类数 − (有幺九字对子 ? 1 : 0)
   * 仅门清有意义，否则返回 Infinity
   */
  function specialShanten(c, meldBudget) {
    if (meldBudget !== 4) return Infinity;
    var pairs = 0, kinds = 0;
    for (var i = 0; i < 34; i++) {
      if (c[i] >= 2) pairs += Math.floor(c[i] / 2);
      if (c[i] > 0) kinds++;
    }
    var chiitoi = 6 - pairs + Math.max(0, 7 - kinds);
    var kt = 0, kpair = false;
    for (var j = 0; j < 34; j++) {
      if (!isHonor(j) && !isTerminal(j)) continue;
      if (c[j] > 0) kt++;
      if (c[j] >= 2) kpair = true;
    }
    var kokushi = 13 - kt - (kpair ? 1 : 0);
    return Math.min(chiitoi, kokushi);
  }

  /**
   * 标准型向听数：向 (meldBudget) 面子 + 雀头 前进的最小步数。
   * -1 表示已和牌（调用方一般先判 isWin）。counts 总张数 = 13 − 3×已副露（±1 摸牌）。
   */
  function standardShanten(c, meldBudget) {
    var best = 8;
    function scan(from, melds, pair, partials) {
      var i = from;
      while (i < 34 && c[i] === 0) i++;
      if (i >= 34) {
        var d = partials;
        if (melds + d > meldBudget) d = meldBudget - melds;
        if (d < 0) d = 0;
        var sh = 8 - 2 * melds - d - pair;
        if (sh < best) best = sh;
        return;
      }
      // 刻子
      if (c[i] >= 3) {
        c[i] -= 3; scan(i, melds + 1, pair, partials); c[i] += 3;
      }
      // 顺子
      if (i < 27 && (i % 9) <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
        c[i]--; c[i + 1]--; c[i + 2]--;
        scan(i, melds + 1, pair, partials);
        c[i]++; c[i + 1]++; c[i + 2]++;
      }
      // 雀头（至多 1 个）
      if (c[i] >= 2 && pair === 0) {
        c[i] -= 2; scan(i, melds, 1, partials); c[i] += 2;
      }
      // 对子搭子
      if (c[i] >= 2) {
        c[i] -= 2; scan(i, melds, pair, partials + 1); c[i] += 2;
      }
      // 两面 / 嵌张搭子
      if (i < 27 && (i % 9) <= 7 && c[i + 1] > 0) {
        c[i]--; c[i + 1]--; scan(i, melds, pair, partials + 1); c[i]++; c[i + 1]++;
      }
      if (i < 27 && (i % 9) <= 6 && c[i + 2] > 0) {
        c[i]--; c[i + 2]--; scan(i, melds, pair, partials + 1); c[i]++; c[i + 2]++;
      }
      // 弃用这张牌
      scan(i + 1, melds, pair, partials);
    }
    scan(0, 0, 0, 0);
    // 标准公式以「4 面子 + 雀头」为目标；副露时目标降为 meldBudget 面子 + 雀头，
    // 每少一个目标面子减少 2 向听
    return best - 2 * (4 - meldBudget);
  }

  /**
   * 综合向听数：min(标准型, 七对, 国士)。已和牌返回 −1。
   * 标准型/七对/国士的公式对完整牌形自然给出 −1，因此不需要再调 isWin。
   */
  function shanten(counts, meldBudget) {
    return Math.min(standardShanten(counts, meldBudget), specialShanten(counts, meldBudget));
  }

  /**
   * 进张数（受入牌）：打掉 drop 后，摸到哪些牌能向听前进。
   * 返回 { count: 张数, kinds: 种类数 }；drop 为 null 表示不打牌（听牌自摸判定用）。
   * unseen：当前没见到的各牌剩余张数（用于把进张换算成真实剩余张数）。
   */
  function ukeire(counts, meldBudget, drop, unseen) {
    var c = counts.slice();
    if (drop !== null && drop !== undefined) c[drop]--;
    var base = shanten(c, meldBudget);
    var total = 0, kinds = 0;
    for (var t = 0; t < 34; t++) {
      if (unseen && !(unseen[t] > 0)) continue;
      if (!unseen && c[t] >= 4) continue;
      c[t]++;
      if (shanten(c, meldBudget) < base) {
        kinds++;
        total += unseen ? unseen[t] : (4 - c[t] + 1);
      }
      c[t]--;
    }
    return { count: total, kinds: kinds };
  }

  /* ---------------- 番种评定 ---------------- */

  /**
   * 和牌番种列表。参数：
   *   counts —— 含和牌张的 34 张数表（仅暗牌）
   *   melds  —— 副露数组 [{type:'peng'|'gang'|'angang'|'chi', tiles:[idx...]}]
   *   winTile, selfDraw
   * 番数采用累加制：得分 = 底分 × 番数。
   */
  function scoreHands(counts, melds, winTile, selfDraw) {
    var fan = 1, names = ['平胡'];
    var menqing = melds.length === 0;
    var i;

    // 花色统计：数牌出现几种花色、有没有字牌
    var suitsSeen = {};
    var hasHonor = false;
    for (i = 0; i < 34; i++) {
      if (counts[i] === 0) continue;
      if (isHonor(i)) hasHonor = true;
      else suitsSeen[Tiles.suitOf(i)] = true;
    }
    // 副露是完整手牌的一部分，花色判定必须一并纳入
    //（否则暗牌全万的牌碰了红中仍会被误评成清一色×4，多付一倍）
    (melds || []).forEach(function (m) {
      (m.tiles || []).forEach(function (idx) {
        if (isHonor(idx)) hasHonor = true;
        else suitsSeen[Tiles.suitOf(idx)] = true;
      });
    });
    var nSuit = Object.keys(suitsSeen).length;

    if (nSuit === 1 && !hasHonor) { fan += 4; names.push('清一色 ×4'); }
    else if (nSuit === 1 && hasHonor) { fan += 2; names.push('混一色 ×2'); }
    else if (nSuit === 0 && hasHonor) { fan += 6; names.push('字一色 ×6'); }

    // 碰碰胡：暗牌可拆成全刻子 + 一对，副露无吃
    var noChi = melds.every(function (m) { return m.type !== 'chi'; });
    if (noChi) {
      var verified = false;
      for (i = 0; i < 34 && !verified; i++) {
        if (counts[i] < 2) continue;
        counts[i] -= 2;
        var allTrips = true;
        for (var k = 0; k < 34; k++) {
          if (counts[k] % 3 !== 0) { allTrips = false; break; }
        }
        counts[i] += 2;
        if (allTrips) verified = true;
      }
      if (verified) { fan += 2; names.push('碰碰胡 ×2'); }
    }

    // 七对
    if (menqing) {
      var pairs = 0, allEven = true;
      for (i = 0; i < 34; i++) {
        if (counts[i] % 2 !== 0) { allEven = false; break; }
        pairs += counts[i] / 2;
      }
      if (allEven && pairs === 7) { fan += 3; names.push('七对 ×3'); }
      // 国士无双（十三幺）
      if (isKokushi(counts)) { fan += 12; names.push('国士无双 ×13'); }
    }

    // 门前清（无副露，非自摸也算，自摸另计）
    if (menqing) { fan += 1; names.push('门前清 ×1'); }
    // 自摸
    if (selfDraw) { fan += 1; names.push('自摸 ×1'); }
    // 杠开（杠后岭上自摸）
    if (selfDraw && winTile && winTile.lingshang) { fan += 1; names.push('杠上开花 ×1'); }
    // 抢杠（由游戏层标注）
    if (!selfDraw && winTile && winTile.qianggang) { fan += 1; names.push('抢杠胡 ×1'); }
    // 天胡 / 地胡（由游戏层标注）
    if (winTile && winTile.tianhu) { fan += 6; names.push('天胡 ×6'); }
    else if (winTile && winTile.dihu) { fan += 3; names.push('地胡 ×3'); }

    return { fan: fan, names: names };
  }

  global.MjRules = {
    isWin: isWin,
    isChiitoi: isChiitoi,
    isKokushi: isKokushi,
    shanten: shanten,
    standardShanten: standardShanten,
    specialShanten: specialShanten,
    ukeire: ukeire,
    scoreHands: scoreHands
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.MjRules;
    global.MjRules.Tiles = Tiles;
  }

})(typeof window !== 'undefined' ? window : globalThis);
