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
 * 战绩按游戏分桶：Store 的所有读取/记录接口都带 game 参数
 * （'ddz' 斗地主 | 'mj' 麻将），省略时默认 'ddz'，老存档完全兼容。
 * 若浏览器禁用了 localStorage（例如极严格隐私模式），自动降级为内存存储。
 * ========================================================================== */
(function (global) {
  'use strict';

  var KEYS = {
    ddz: 'doudizhu.stats.v1',
    mj: 'majiang.stats.v1'
  };
  var PREF_KEY = 'doudizhu.prefs.v1';

  var DEFAULT_STATS = {
    games: 0,          // 总对局数
    wins: 0,           // 总获胜数（麻将用总胜率；斗地主可由地主/农民分项推出）
    landlordGames: 0,  // 当过地主的次数（斗地主）
    landlordWins: 0,   // 地主获胜次数（斗地主）
    farmerGames: 0,    // 当农民的次数（斗地主）
    farmerWins: 0,     // 农民获胜次数（斗地主）
    score: 0,          // 累计积分
    streak: 0,         // 当前连胜
    bestStreak: 0,     // 最高连胜
    bombs: 0,          // 打出炸弹总数（斗地主）
    springs: 0         // 春天次数（斗地主）
  };

  var DEFAULT_PREFS = {
    difficulty: 'hard',
    sound: true,
    music: true,
    musicVolume: 0.4,
    voice: true,
    animation: true,
    baseScore: 100,
    gameMode: 'ddz',        // 上次玩的模式（大厅高亮用）
    mjDifficulty: 'hard'
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

  function keyOf(game) { return KEYS[game === 'mj' ? 'mj' : 'ddz']; }

  function getStats(game) { return load(keyOf(game), DEFAULT_STATS); }

  function getPrefs() { return load(PREF_KEY, DEFAULT_PREFS); }

  function setPrefs(patch) {
    var p = getPrefs();
    Object.assign(p, patch || {});
    save(PREF_KEY, p);
    return p;
  }

  /**
   * 记录一局结果
   * result: { role, win:Boolean, delta:Number, bombs:Number, spring:Boolean }
   * game:   'ddz'（默认）| 'mj'；麻将的 role 固定 'mahjong'，不计入地主/农民分项
   */
  function recordGame(result, game) {
    var s = getStats(game);
    s.games += 1;
    if (result.win) s.wins += 1;
    if (result.role === 'landlord' || result.role === 'farmer') {
      if (result.role === 'landlord') {
        s.landlordGames += 1;
        if (result.win) s.landlordWins += 1;
      } else {
        s.farmerGames += 1;
        if (result.win) s.farmerWins += 1;
      }
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
    save(keyOf(game), s);
    return s;
  }

  function resetStats(game) {
    save(keyOf(game), Object.assign({}, DEFAULT_STATS));
    return getStats(game);
  }

  function winRate(game) {
    var s = getStats(game);
    if (!s.games) return 0;
    if (game === 'mj') return s.wins / s.games;
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
