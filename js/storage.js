/* 斗地主 —— 纯前端单机斗地主游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * storage.js —— 战绩统计与本地存档（localStorage）
 * 若浏览器禁用了 localStorage（例如极严格隐私模式），自动降级为内存存储。
 * ========================================================================== */
(function (global) {
  'use strict';

  var KEY = 'doudizhu.stats.v1';
  var PREF_KEY = 'doudizhu.prefs.v1';

  var DEFAULT_STATS = {
    games: 0,          // 总对局数
    landlordGames: 0,  // 当过地主的次数
    landlordWins: 0,   // 地主获胜次数
    farmerGames: 0,    // 当农民的次数
    farmerWins: 0,     // 农民获胜次数
    score: 0,          // 累计积分
    streak: 0,         // 当前连胜
    bestStreak: 0,     // 最高连胜
    bombs: 0,          // 打出炸弹总数
    springs: 0         // 春天次数
  };

  var DEFAULT_PREFS = {
    difficulty: 'hard',
    sound: true,
    music: true,
    musicVolume: 0.4,
    voice: true,
    animation: true,
    baseScore: 100
  };

  var memStore = {};
  var lsOk = (function () {
    try {
      var k = '__ddz_test__';
      global.localStorage.setItem(k, '1');
      global.localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  })();

  function readRaw(key) {
    if (lsOk) {
      try { return global.localStorage.getItem(key); } catch (e) { /* 忽略 */ }
    }
    return memStore[key] === undefined ? null : memStore[key];
  }

  function writeRaw(key, val) {
    if (lsOk) {
      try { global.localStorage.setItem(key, val); return; } catch (e) { /* 忽略 */ }
    }
    memStore[key] = val;
  }

  function load(key, defaults) {
    var raw = readRaw(key);
    if (!raw) return Object.assign({}, defaults);
    try {
      var obj = JSON.parse(raw);
      return Object.assign({}, defaults, obj);
    } catch (e) {
      return Object.assign({}, defaults);
    }
  }

  function save(key, obj) {
    writeRaw(key, JSON.stringify(obj));
  }

  function getStats() { return load(KEY, DEFAULT_STATS); }

  function getPrefs() { return load(PREF_KEY, DEFAULT_PREFS); }

  function setPrefs(patch) {
    var p = getPrefs();
    Object.assign(p, patch || {});
    save(PREF_KEY, p);
    return p;
  }

  /**
   * 记录一局结果
   * result: { role:'landlord'|'farmer', win:Boolean, delta:Number, bombs:Number, spring:Boolean }
   */
  function recordGame(result) {
    var s = getStats();
    s.games += 1;
    if (result.role === 'landlord') {
      s.landlordGames += 1;
      if (result.win) s.landlordWins += 1;
    } else {
      s.farmerGames += 1;
      if (result.win) s.farmerWins += 1;
    }
    s.score += (result.delta || 0);
    s.bombs += (result.bombs || 0);
    if (result.spring) s.springs += 1;

    if (result.win) {
      s.streak += 1;
      if (s.streak > s.bestStreak) s.bestStreak = s.streak;
    } else {
      s.streak = 0;
    }
    save(KEY, s);
    return s;
  }

  function resetStats() {
    save(KEY, Object.assign({}, DEFAULT_STATS));
    return getStats();
  }

  function winRate() {
    var s = getStats();
    if (!s.games) return 0;
    return (s.landlordWins + s.farmerWins) / s.games;
  }

  global.Store = {
    getStats: getStats,
    getPrefs: getPrefs,
    setPrefs: setPrefs,
    recordGame: recordGame,
    resetStats: resetStats,
    winRate: winRate,
    persistent: lsOk
  };

})(typeof window !== 'undefined' ? window : globalThis);
