/* 斗地主&麻将 · 棋牌合集 —— 纯前端单机游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * mj/tiles.js —— 麻将牌模型（136 张：万/条/筒 1-9 ×4 + 东南西北中发白 ×4）
 * 纯逻辑模块，不依赖 DOM，可在 Node 中直接 require 做单元测试。
 *
 * 牌的内部索引 idx（0..33）：
 *   0-8   一万..九万
 *   9-17  一条..九条
 *   18-26 一筒..九筒
 *   27-33 东 南 西 北 中 发 白
 * ========================================================================== */
(function (global) {
  'use strict';

  var SUIT_NAME = { m: '万', s: '条', p: '筒', z: '字' };
  // 字牌简称（idx 27..33）
  var HONOR_SHORT = ['东', '南', '西', '北', '中', '发', '白'];
  var HONOR_LABEL = ['东风', '南风', '西风', '北风', '红中', '发财', '白板'];
  var NUM_CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

  function idxOf(suit, num) {
    switch (suit) {
      case 'm': return num - 1;
      case 's': return 9 + num - 1;
      case 'p': return 18 + num - 1;
      default: return 27 + num - 1;   // 字牌 num: 1..7
    }
  }

  function suitOf(idx) {
    if (idx < 9) return 'm';
    if (idx < 18) return 's';
    if (idx < 27) return 'p';
    return 'z';
  }

  /** 牌的短标记：万/条/筒用 数字+花色字，字牌用单字 */
  function shortOf(idx) {
    if (idx < 27) return (idx % 9 + 1) + SUIT_NAME[suitOf(idx)];
    return HONOR_SHORT[idx - 27];
  }

  function labelOf(idx) {
    if (idx < 27) return NUM_CN[idx % 9] + SUIT_NAME[suitOf(idx)];
    return HONOR_LABEL[idx - 27];
  }

  /** idx 是否为字牌 / 幺九（用于清一色、碰碰胡之外的番种判断） */
  function isHonor(idx) { return idx >= 27; }
  function isTerminal(idx) { return idx < 27 && (idx % 9 === 0 || idx % 9 === 8); }

  /** 生成 136 张牌（每张有全局唯一 id），不洗牌 */
  function makeDeck() {
    var deck = [];
    var id = 0;
    for (var idx = 0; idx < 34; idx++) {
      for (var copy = 0; copy < 4; copy++) {
        deck.push({
          id: id++,
          idx: idx,
          suit: suitOf(idx),
          label: labelOf(idx),
          short: shortOf(idx)
        });
      }
    }
    return deck;
  }

  /** Fisher–Yates 洗牌 */
  function shuffle(arr, rng) {
    var rnd = rng || Math.random;
    for (var i = arr.length - 1; i > 0; i--) {
      var j = (rnd() * (i + 1)) | 0;
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /** 计数向量：牌对象数组 → 长度 34 的张数表 */
  function countsOf(tiles) {
    var c = new Array(34).fill(0);
    for (var i = 0; i < tiles.length; i++) c[tiles[i].idx]++;
    return c;
  }

  /** 手牌排序：万 → 条 → 筒 → 字，花色内按点数 */
  function sortTiles(tiles) {
    tiles.sort(function (a, b) {
      if (a.idx !== b.idx) return a.idx - b.idx;
      return a.id - b.id;
    });
    return tiles;
  }

  global.MjTiles = {
    SUIT_NAME: SUIT_NAME,
    HONOR_SHORT: HONOR_SHORT,
    idxOf: idxOf,
    suitOf: suitOf,
    shortOf: shortOf,
    labelOf: labelOf,
    isHonor: isHonor,
    isTerminal: isTerminal,
    makeDeck: makeDeck,
    shuffle: shuffle,
    countsOf: countsOf,
    sortTiles: sortTiles
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.MjTiles;

})(typeof window !== 'undefined' ? window : globalThis);
