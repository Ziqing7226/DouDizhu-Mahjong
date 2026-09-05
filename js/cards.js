/* 斗地主 —— 纯前端单机斗地主游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * cards.js —— 扑克牌模型 / 牌型识别 / 大小比较 / 压制组合枚举
 * 纯逻辑模块，不依赖 DOM，可在 Node 中直接 require 做单元测试。
 * ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------- 基础常量 ---------------- */

  // 点数：3..10 为面值，J=11 Q=12 K=13 A=14 2=15 小王=16 大王=17
  var R_LABEL = ['', '', '', '3', '4', '5', '6', '7', '8', '9', '10',
    'J', 'Q', 'K', 'A', '2', '小王', '大王'];
  // 卡牌角标用的短标记
  var R_SHORT = ['', '', '', '3', '4', '5', '6', '7', '8', '9', '10',
    'J', 'Q', 'K', 'A', '2', 'w', 'W'];

  var SUITS = [
    { key: 'diamond', sym: '♦', red: true },
    { key: 'club', sym: '♣', red: false },
    { key: 'heart', sym: '♥', red: true },
    { key: 'spade', sym: '♠', red: false }
  ];

  // 牌型
  var CT = {
    SINGLE: 1, PAIR: 2, TRIPLE: 3, TRIPLE_ONE: 4, TRIPLE_PAIR: 5,
    STRAIGHT: 6, DOUBLE_STRAIGHT: 7, TRIPLE_STRAIGHT: 8,
    AIRPLANE_ONE: 9, AIRPLANE_PAIR: 10,
    FOUR_TWO: 11, FOUR_TWO_PAIR: 12,
    BOMB: 13, ROCKET: 14
  };
  var CT_NAME = {
    1: '单张', 2: '对子', 3: '三张', 4: '三带一', 5: '三带二',
    6: '顺子', 7: '连对', 8: '飞机', 9: '飞机带单', 10: '飞机带对',
    11: '四带二', 12: '四带两对', 13: '炸弹', 14: '王炸'
  };

  var MAX_STRAIGHT_RANK = 14; // 顺子/连对/飞机的主体最高到 A，不能含 2 和王

  /* ---------------- 牌的构造 ---------------- */

  /** id 规则：0..51 为普通牌（rank=3+idx/4, suit=idx%4），52 小王，53 大王 */
  function makeCard(id) {
    if (id >= 52) {
      return { id: id, rank: id === 52 ? 16 : 17, suit: -1, joker: true,
        sym: '🃏', red: id === 53, label: id === 52 ? '小王' : '大王' };
    }
    var rank = 3 + ((id / 4) | 0);
    var s = SUITS[id % 4];
    return { id: id, rank: rank, suit: id % 4, joker: false,
      sym: s.sym, red: s.red, label: R_LABEL[rank] };
  }

  /** 生成一副 54 张牌 */
  function makeDeck() {
    var deck = [];
    for (var i = 0; i < 54; i++) deck.push(makeCard(i));
    return deck;
  }

  /** Fisher–Yates 洗牌，原地打乱并返回 */
  function shuffle(arr, rng) {
    var rnd = rng || Math.random;
    for (var i = arr.length - 1; i > 0; i--) {
      var j = (rnd() * (i + 1)) | 0;
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /** 手牌排序：点数降序（大牌在左），同点数按花色 */
  function sortCards(cards) {
    cards.sort(function (a, b) {
      if (b.rank !== a.rank) return b.rank - a.rank;
      return a.id - b.id;
    });
    return cards;
  }

  /** 点数升序排序（用于顺子展示） */
  function sortAsc(cards) {
    cards.sort(function (a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.id - b.id;
    });
    return cards;
  }

  /* ---------------- 工具 ---------------- */

  function rankCounts(cards) {
    var c = new Array(18).fill(0);
    for (var i = 0; i < cards.length; i++) c[cards[i].rank]++;
    return c;
  }

  function countsKey(c) { return c.join(','); }

  function isConsecutive(sortedRanks) {
    for (var i = 1; i < sortedRanks.length; i++) {
      if (sortedRanks[i] - sortedRanks[i - 1] !== 1) return false;
    }
    return true;
  }

  /** 取数组所有「极大连续段」，再展开为长度>=2 的所有连续子段（按长度降序） */
  function allRuns(ranks, minLen) {
    var out = [];
    var i = 0;
    while (i < ranks.length) {
      var j = i;
      while (j + 1 < ranks.length && ranks[j + 1] - ranks[j] === 1) j++;
      var seg = ranks.slice(i, j + 1);
      for (var L = seg.length; L >= (minLen || 2); L--) {
        for (var s = 0; s + L <= seg.length; s++) out.push(seg.slice(s, s + L));
      }
      i = j + 1;
    }
    // 长的优先，长的匹配失败再试短的
    out.sort(function (a, b) { return b.length - a.length; });
    return out;
  }

  /* ---------------- 牌型识别 ---------------- */

  /**
   * 识别一手牌。合法返回 { type, main, len, cards }，否则返回 null。
   * main  = 用于比大小的主点数
   * len   = 主体长度（顺子张数 / 连对对数 / 飞机三张组数）
   */
  function parse(cards) {
    if (!cards || cards.length === 0) return null;
    var n = cards.length;
    var c = rankCounts(cards);
    var ranks = [];
    for (var r = 3; r <= 17; r++) if (c[r]) ranks.push(r);
    var kinds = ranks.length;
    var maxR = ranks[kinds - 1];
    var i, seg;

    /* --- 王炸 --- */
    if (n === 2 && c[16] === 1 && c[17] === 1) {
      return { type: CT.ROCKET, main: 17, len: 1, cards: cards.slice() };
    }
    /* --- 炸弹 --- */
    if (n === 4 && kinds === 1) {
      return { type: CT.BOMB, main: maxR, len: 1, cards: cards.slice() };
    }
    /* --- 单 / 对 / 三 --- */
    if (kinds === 1) {
      // 大小王各只有一张，不可能凑成对子或三张
      if (n >= 2 && maxR >= 16) return null;
      if (n === 1) return { type: CT.SINGLE, main: maxR, len: 1, cards: cards.slice() };
      if (n === 2) return { type: CT.PAIR, main: maxR, len: 1, cards: cards.slice() };
      if (n === 3) return { type: CT.TRIPLE, main: maxR, len: 1, cards: cards.slice() };
      return null;
    }
    /* --- 三带一 / 三带二 --- */
    if (kinds === 2) {
      var tri = -1, other = -1;
      for (i = 0; i < kinds; i++) if (c[ranks[i]] === 3) tri = ranks[i]; else other = ranks[i];
      if (tri >= 0 && other >= 0) {
        if (n === 4 && c[other] === 1) return { type: CT.TRIPLE_ONE, main: tri, len: 1, cards: cards.slice() };
        if (n === 5 && c[other] === 2) return { type: CT.TRIPLE_PAIR, main: tri, len: 1, cards: cards.slice() };
      }
    }
    /* --- 顺子 --- */
    if (n >= 5 && maxR <= MAX_STRAIGHT_RANK && kinds === n && isConsecutive(ranks)) {
      return { type: CT.STRAIGHT, main: maxR, len: n, cards: cards.slice() };
    }
    /* --- 连对 --- */
    if (n >= 6 && n % 2 === 0 && maxR <= MAX_STRAIGHT_RANK &&
      kinds === n / 2 && isConsecutive(ranks)) {
      var allPair = true;
      for (i = 0; i < kinds; i++) if (c[ranks[i]] !== 2) { allPair = false; break; }
      if (allPair) return { type: CT.DOUBLE_STRAIGHT, main: maxR, len: n / 2, cards: cards.slice() };
    }
    /* --- 飞机系列（含纯飞机 / 带单 / 带对） ---
     * 三顺本体不含 2 和王；翅膀可以含 2、单王（双王不可拆为翅膀，
     * 见 wingsOk），因此本分支不能用整手 maxR 做门槛（会误杀带
     * 王/2 翅膀的合法飞机），改为逐段检查三顺自身点数。 */
    if (n >= 6) {
      var tripRanks = ranks.filter(function (x) { return c[x] >= 3; });
      if (tripRanks.length >= 2) {
        var runs = allRuns(tripRanks, 2);
        for (i = 0; i < runs.length; i++) {
          seg = runs[i];
          var m = seg.length;
          if (seg[m - 1] > MAX_STRAIGHT_RANK) continue;   // 三顺不含 2（seg 内已连续，查最大即可）
          // 纯飞机
          if (n === 3 * m && tripRanks.length === m) {
            return { type: CT.TRIPLE_STRAIGHT, main: seg[m - 1], len: m, cards: cards.slice() };
          }
          // 飞机带单：主体 3m + 翅膀 m 张
          if (n === 4 * m && wingsOk(c, seg, m, 1)) {
            return { type: CT.AIRPLANE_ONE, main: seg[m - 1], len: m, cards: cards.slice() };
          }
          // 飞机带对：主体 3m + 翅膀 m 对
          if (n === 5 * m && wingsOk(c, seg, m, 2)) {
            return { type: CT.AIRPLANE_PAIR, main: seg[m - 1], len: m, cards: cards.slice() };
          }
        }
      }
    }
    /* --- 四带二 / 四带两对 --- */
    var quads = ranks.filter(function (x) { return c[x] === 4; });
    if (quads.length === 1) {
      if (n === 6) {
        // 欢乐斗地主：四带二单的两张单牌不能是大小王（王炸不可拆带）
        if (c[16] === 1 && c[17] === 1) return null;
        return { type: CT.FOUR_TWO, main: quads[0], len: 1, cards: cards.slice() };
      }
      if (n === 8) {
        var restRanks = ranks.filter(function (x) { return x !== quads[0]; });
        var pairs = restRanks.filter(function (x) { return c[x] === 2; });
        if (restRanks.length === 2 && pairs.length === 2) {
          return { type: CT.FOUR_TWO_PAIR, main: quads[0], len: 1, cards: cards.slice() };
        }
      }
    }
    return null;
  }

  /**
   * 检查飞机翅膀是否合法。
   * c     : 点数计数数组
   * seg   : 飞机主体的连续点数
   * m     : 主体三张组数
   * size  : 1=带单张，2=带对子
   * 约束：主体用掉每个点数 3 张后，剩余牌刚好构成翅膀，且不允许拆炸弹当翅膀；
   * 按欢乐斗地主规则，翅膀不能同时含大小王（王炸不可拆为翅膀）。
   */
  function wingsOk(c, seg, m, size) {
    var used = new Array(18).fill(0);
    for (var i = 0; i < m; i++) used[seg[i]] = 3;
    var need = m * size;
    var total = 0, units = 0, jokerWings = 0;
    for (var r = 3; r <= 17; r++) {
      var left = c[r] - (used[r] || 0);
      if (left < 0) return false;
      if (left === 0) continue;
      if (left >= 4) return false;          // 翅膀不含炸弹
      total += left;
      if (size === 1) {
        units += left;                       // 单张翅膀：几张算几个
      } else {
        if (left < 2) return false;          // 对子翅膀：必须成对
        units += Math.floor(left / 2);
      }
      if (size === 1 && r >= 16) jokerWings += left;
    }
    if (jokerWings >= 2) return false;      // 王炸不可拆为飞机翅膀
    return total === need && units >= m;
  }

  /* ---------------- 大小比较 ---------------- */

  /** a 能否压过 b。b 为 null 表示自由出牌（只要合法即可） */
  function canBeat(a, b) {
    if (!a) return false;
    if (!b) return true;
    if (a.type === CT.ROCKET) return b.type !== CT.ROCKET;
    if (b.type === CT.ROCKET) return false;
    if (a.type === CT.BOMB && b.type !== CT.BOMB) return true;
    if (b.type === CT.BOMB && a.type !== CT.BOMB) return false;
    if (a.type !== b.type) return false;
    if (a.len !== b.len) return false;
    return a.main > b.main;
  }

  /* ---------------- 出牌组合枚举 ---------------- */

  function groupByRank(hand) {
    var m = new Map();
    for (var i = 0; i < hand.length; i++) {
      var c = hand[i];
      if (!m.has(c.rank)) m.set(c.rank, []);
      m.get(c.rank).push(c);
    }
    m.forEach(function (arr) { arr.sort(function (x, y) { return x.id - y.id; }); });
    return m;
  }

  /** 从 groups 中取 rank 的前 k 张 */
  function take(g, rank, k) {
    var arr = g.get(rank);
    if (!arr || arr.length < k) return null;
    return arr.slice(0, k);
  }

  /**
   * 挑选「带牌翅膀」：优先点数小、数量刚好、不拆炸弹、不浪费王。
   * size=1 选单张，size=2 选对子。返回最多 2 套候选（数组形式）。
   */
  function pickWings(g, excludeRanks, count, size) {
    var ex = {};
    for (var i = 0; i < excludeRanks.length; i++) ex[excludeRanks[i]] = true;
    var cand = [];
    g.forEach(function (arr, rank) {
      if (ex[rank]) return;
      if (size === 1) {
        if (arr.length >= 4) return;              // 不拆炸弹
        // 单张翅膀允许用王：cand 按点数升序取用，别的牌够时轮不到王，
        // 与 ai.js unseenHasBeat 的对手建模口径一致——否则「对手能用王
        // 组三带一压我」而我方跟牌候选永远生成不出这一手
        cand.push({ rank: rank, cards: [arr[0]] });
      } else {
        if (arr.length < 2) return;
        if (arr.length >= 4) return;              // 不拆炸弹
        if (rank >= 16) return;
        cand.push({ rank: rank, cards: arr.slice(0, 2) });
      }
    });
    if (cand.length < count) return [];
    cand.sort(function (a, b) { return a.rank - b.rank; });
    var sets = [];
    var pick = function (offset) {
      var out = [];
      for (var k = 0; k < count; k++) {
        var idx = offset + k;
        if (idx >= cand.length) return null;
        out = out.concat(cand[idx].cards);
      }
      return out;
    };
    var s0 = pick(0);
    if (s0) sets.push(s0);
    // 再给一套「跳过最小的」方案，避免把关键小牌浪费掉
    var s1 = pick(1);
    if (s1 && cand.length > count) sets.push(s1);
    return sets;
  }

  /**
   * 枚举手牌中所有能压过 target 的出牌组合。
   * target 为 null 时不做过滤（由调用方另行处理）。
   * 返回 Card[][] —— 已按「点数尽量小」排序的候选列表。
   */
  function findBeats(hand, target) {
    var res = [];
    var g = groupByRank(hand);
    var ranks = Array.from(g.keys()).sort(function (a, b) { return a - b; });
    var cnt = function (r) { var a = g.get(r); return a ? a.length : 0; };
    var i, r, k, segs, seg;

    var isBombTarget = target && target.type === CT.BOMB;
    var isRocketTarget = target && target.type === CT.ROCKET;

    /* 炸弹 */
    if (!isRocketTarget) {
      for (i = 0; i < ranks.length; i++) {
        r = ranks[i];
        if (cnt(r) === 4 && (!isBombTarget || r > target.main) && (!target || target.type !== CT.ROCKET)) {
          res.push(g.get(r).slice(0, 4));
        }
      }
    }
    /* 王炸 */
    if (!isRocketTarget && cnt(16) >= 1 && cnt(17) >= 1) {
      res.push([g.get(16)[0], g.get(17)[0]]);
    }

    if (!target) return dedupe(res);

    var T = target.type, L = target.len, M = target.main;

    switch (T) {
      case CT.SINGLE:
        for (i = 0; i < ranks.length; i++) {
          r = ranks[i];
          if (r > M) res.push([g.get(r)[0]]);
        }
        break;

      case CT.PAIR:
        for (i = 0; i < ranks.length; i++) {
          r = ranks[i];
          if (r > M && r < 16 && cnt(r) >= 2) res.push(g.get(r).slice(0, 2));
        }
        break;

      case CT.TRIPLE:
        for (i = 0; i < ranks.length; i++) {
          r = ranks[i];
          if (r > M && cnt(r) >= 3) res.push(g.get(r).slice(0, 3));
        }
        break;

      case CT.TRIPLE_ONE:
      case CT.TRIPLE_PAIR: {
        var wSize = (T === CT.TRIPLE_ONE) ? 1 : 2;
        for (i = 0; i < ranks.length; i++) {
          r = ranks[i];
          if (r > M && cnt(r) >= 3) {
            var ws = pickWings(g, [r], 1, wSize);
            for (k = 0; k < ws.length; k++) res.push(g.get(r).slice(0, 3).concat(ws[k]));
          }
        }
        break;
      }

      case CT.STRAIGHT: {
        segs = straightRuns(ranks, cnt, L, 1);
        for (i = 0; i < segs.length; i++) {
          if (segs[i][L - 1] > M) res.push(flatten(g, segs[i], 1));
        }
        break;
      }

      case CT.DOUBLE_STRAIGHT: {
        segs = straightRuns(ranks, cnt, L, 2);
        for (i = 0; i < segs.length; i++) {
          if (segs[i][L - 1] > M) res.push(flatten(g, segs[i], 2));
        }
        break;
      }

      case CT.TRIPLE_STRAIGHT: {
        segs = straightRuns(ranks, cnt, L, 3);
        for (i = 0; i < segs.length; i++) {
          if (segs[i][L - 1] > M) res.push(flatten(g, segs[i], 3));
        }
        break;
      }

      case CT.AIRPLANE_ONE:
      case CT.AIRPLANE_PAIR: {
        var aSize = (T === CT.AIRPLANE_ONE) ? 1 : 2;
        segs = straightRuns(ranks, cnt, L, 3);
        for (i = 0; i < segs.length; i++) {
          seg = segs[i];
          if (seg[L - 1] <= M) continue;
          var ws2 = pickWings(g, seg, L, aSize);
          for (k = 0; k < ws2.length; k++) res.push(flatten(g, seg, 3).concat(ws2[k]));
        }
        break;
      }

      case CT.FOUR_TWO:
      case CT.FOUR_TWO_PAIR: {
        var fSize = (T === CT.FOUR_TWO) ? 1 : 2;
        for (i = 0; i < ranks.length; i++) {
          r = ranks[i];
          if (r > M && cnt(r) === 4) {
            var ws3 = pickWings(g, [r], fSize === 1 ? 2 : 2, fSize);
            for (k = 0; k < ws3.length; k++) res.push(g.get(r).slice(0, 4).concat(ws3[k]));
          }
        }
        break;
      }

      case CT.BOMB:
      case CT.ROCKET:
        // 已在上方统一处理
        break;
    }
    return dedupe(res);
  }

  /** 找出长度为 len、每个点数张数 >= need 的连续段（点数 <= A） */
  function straightRuns(ranks, cnt, len, need) {
    var pool = ranks.filter(function (r) { return r <= MAX_STRAIGHT_RANK && cnt(r) >= need; });
    var out = [];
    for (var s = 0; s + len <= pool.length; s++) {
      var seg = pool.slice(s, s + len);
      if (isConsecutive(seg)) out.push(seg);
    }
    return out;
  }

  function flatten(g, seg, per) {
    var out = [];
    for (var i = 0; i < seg.length; i++) out = out.concat(g.get(seg[i]).slice(0, per));
    return out;
  }

  /** 去重（按 id 集合） */
  function dedupe(list) {
    var seen = new Set(), out = [];
    for (var i = 0; i < list.length; i++) {
      var key = list[i].map(function (c) { return c.id; }).sort(function (a, b) { return a - b; }).join('-');
      if (!seen.has(key)) { seen.add(key); out.push(list[i]); }
    }
    return out;
  }

  /* ---------------- 辅助 ---------------- */

  /** 这手牌里含多少个炸弹/王炸 */
  function countBombs(cards) {
    var c = rankCounts(cards), n = 0;
    for (var r = 3; r <= 15; r++) if (c[r] === 4) n++;
    if (c[16] && c[17]) n++;
    return n;
  }

  function hasRocket(cards) {
    var c = rankCounts(cards);
    return c[16] > 0 && c[17] > 0;
  }

  function describe(combo) {
    if (!combo) return '';
    if (combo.type === CT.ROCKET) return '王炸';
    if (combo.type === CT.BOMB) return '炸弹';
    if (combo.type === CT.STRAIGHT || combo.type === CT.DOUBLE_STRAIGHT ||
      combo.type === CT.TRIPLE_STRAIGHT) {
      return R_LABEL[combo.main] + CT_NAME[combo.type];
    }
    return CT_NAME[combo.type];
  }

  /* ---------------- 导出 ---------------- */
  var API = {
    R_LABEL: R_LABEL, R_SHORT: R_SHORT, SUITS: SUITS, CT: CT, CT_NAME: CT_NAME,
    makeCard: makeCard, makeDeck: makeDeck, shuffle: shuffle,
    sortCards: sortCards, sortAsc: sortAsc,
    rankCounts: rankCounts, isConsecutive: isConsecutive, allRuns: allRuns,
    parse: parse, canBeat: canBeat, findBeats: findBeats,
    groupByRank: groupByRank, countBombs: countBombs, hasRocket: hasRocket,
    describe: describe, MAX_STRAIGHT_RANK: MAX_STRAIGHT_RANK
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.Cards = API;

})(typeof window !== 'undefined' ? window : globalThis);
