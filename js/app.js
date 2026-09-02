/* 斗地主&麻将 · 棋牌合集 —— 纯前端单机游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * app.js —— 游戏模式调度
 * 进入页面先展示「选择游戏」大厅（斗地主 / 麻将），选定后进入对应模式；
 * 左上角 🎮 按钮随时切回模式大厅。战绩/规则按钮按当前模式分发。
 * ========================================================================== */
(function (global) {
  'use strict';

  var Store = global.Store;
  var UI = global.UI;

  var App = {
    current: null        // 'ddz' | 'mj' | null（在模式大厅）
  };

  function el(id) { return document.getElementById(id); }

  var DOM = {};

  function bindDom() {
    ['gameLobby', 'btnGameMode', 'logoText', 'ddzView', 'mjView'].forEach(function (id) {
      DOM[id] = el(id);
    });
  }

  /** 打开模式大厅：挂起当前游戏、显示选择层 */
  App.showModeLobby = function () {
    if (App.current === 'ddz' && global.Game) global.Game.suspend();
    if (App.current === 'mj' && global.MjGame) global.MjGame.suspend();
    App.current = null;
    UI.closeDialog();
    highlightRooms();
    DOM.gameLobby.classList.add('show');
  };

  /** 进入某个游戏：切换视图 + 显示它的选场大厅 */
  App.enterGame = function (mode) {
    if (mode !== 'ddz' && mode !== 'mj') return;
    Store.setPrefs({ gameMode: mode });
    App.current = mode;
    DOM.gameLobby.classList.remove('show');
    DOM.ddzView.style.display = (mode === 'ddz') ? '' : 'none';
    DOM.mjView.style.display = (mode === 'mj') ? '' : 'none';
    DOM.logoText.textContent = (mode === 'ddz') ? '斗地主' : '麻将';
    document.title = (mode === 'ddz') ? '斗地主' : '麻将';
    if (mode === 'ddz') global.Game.enterLobby();
    else global.MjGame.enterLobby();
  };

  function highlightRooms() {
    var prefs = Store.getPrefs();
    var last = prefs.gameMode === 'mj' ? 'mj' : 'ddz';
    var btns = DOM.gameLobby.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('last', btns[i].dataset.game === last);
    }
  }

  function init() {
    bindDom();

    // 左上角：切换游戏模式
    DOM.btnGameMode.addEventListener('click', function () {
      App.showModeLobby();
      UI.toast('选择一款游戏');
      if (global.Sound) global.Sound.play('select');
    });

    // 模式大厅按钮
    var btns = DOM.gameLobby.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          App.enterGame(btn.dataset.game);
          if (global.Sound) global.Sound.play('select');
        });
      })(btns[i]);
    }

    highlightRooms();
    DOM.gameLobby.classList.add('show');   // 进入页面先选游戏
  }

  global.App = App;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})(typeof window !== 'undefined' ? window : globalThis);
