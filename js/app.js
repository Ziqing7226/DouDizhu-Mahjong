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
    ['gameLobby', 'btnGameMode', 'logoText', 'ddzView', 'mjView',
      'btnFullscreen', 'fsBanner', 'btnFsGo', 'btnFsClose'].forEach(function (id) {
      DOM[id] = el(id);
    });
  }

  /** 打开模式大厅：挂起当前游戏、显示选择层 */
  App.showModeLobby = function () {
    if (App.current === 'ddz' && global.Game) global.Game.suspend();
    if (App.current === 'mj' && global.MjGame) global.MjGame.suspend();
    App.current = null;
    UI.closeDialog();
    document.querySelectorAll('.sidebar.open').forEach(function (s) {
      s.classList.remove('open');
    });
    document.querySelectorAll('.game-view.drawer-open').forEach(function (v) {
      v.classList.remove('drawer-open');
    });
    highlightRooms();
    DOM.gameLobby.classList.add('show');
  };

  /** 进入某个游戏：切换视图 + 显示它的选场大厅 */
  App.enterGame = function (mode) {
    if (mode !== 'ddz' && mode !== 'mj') return;
    Store.setPrefs({ gameMode: mode });
    App.current = mode;
    // 收起所有抽屉（移动端侧栏）
    document.querySelectorAll('.sidebar.open').forEach(function (s) {
      s.classList.remove('open');
    });
    document.querySelectorAll('.game-view.drawer-open').forEach(function (v) {
      v.classList.remove('drawer-open');
    });
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

  /* ---------------- 全屏（移动端横屏时建议开启） ---------------- */

  function fsElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }
  function fsRequest(el) {
    return (el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen || null);
  }
  function fsExit() {
    return (document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen || null);
  }

  function toggleFullscreen() {
    var el = document.documentElement;
    if (!fsElement()) {
      var req = fsRequest(el);
      if (req) {
        try {
          var p = req.call(el);
          if (p && p.catch) p.catch(function () { showFsTip(); });
        } catch (e) { showFsTip(); }
        return true;
      }
      showFsTip();   // 不支持全屏 API（如 iPhone Safari）
      return false;
    }
    var ex = fsExit();
    if (ex) { try { ex.call(document); } catch (e) { /* 忽略 */ } }
    return true;
  }

  /** 进入不了全屏时，展开文字指引 */
  function showFsTip() {
    DOM.fsBanner.classList.add('show', 'show-tip');
  }

  /** 全屏建议条：仅移动端 + 横屏 + 未全屏 + 未关闭过时出现 */
  var FS_HINT_KEY = 'doudizhu.fsHintClosed';
  function updateFsBanner() {
    var mobile = document.body.classList.contains('is-mobile');
    var landscape = global.innerWidth >= global.innerHeight;
    var dismissed = false;
    try { dismissed = localStorage.getItem(FS_HINT_KEY) === '1'; } catch (e) { /* 忽略 */ }
    var show = mobile && landscape && !fsElement() && !dismissed;
    DOM.fsBanner.classList.toggle('show', show);
    if (!show) DOM.fsBanner.classList.remove('show-tip');
  }

  function syncFsButton() {
    DOM.btnFullscreen.textContent = fsElement() ? '⛶' : '⛶';
    DOM.btnFullscreen.classList.toggle('off', !!fsElement());
  }

  /* ---------------- 温馨提醒（健康休息） ---------------- */

  /**
   * 「记忆时刻」：刚进入游戏时记住当下；每逢开局前检查，
   * 距上次记忆超过 30 分钟则在结算面板之后、开局之前弹出休息提醒，
   * 用户确认「休息完毕」后放行，并在这次开局重新记忆时刻。
   */
  var Health = {
    stamp: Date.now(),
    LIMIT: 30 * 60 * 1000,
    remember: function () { this.stamp = Date.now(); },
    overdue: function () { return Date.now() - this.stamp > this.LIMIT; },
    /**
     * 开局闸门：超时则弹提醒并拦截本次开局；确认后重新记忆并执行 cb()。
     * 返回 true 表示已被拦截。
     */
    gate: function (cb) {
      if (!this.overdue()) return false;
      var self = this;
      UI.showDialog(
        '<h2>温馨提醒</h2>' +
        '<div class="sec"><p style="text-align:center;font-size:15px;">你已经连续游玩超过半小时啦～</p></div>' +
        '<div class="sec"><p>长时间盯着屏幕容易疲劳。建议放下手机，' +
        '<b>看看远处放松眼睛，站起来活动一下身体</b>，喝口水，再回来继续愉快的牌局！</p></div>',
        [{
          text: '休息完毕，继续游戏', cls: 'gold',
          onClick: function () { self.remember(); if (cb) cb(); }
        }]
      );
      if (global.Sound) global.Sound.play('spring');
      return true;
    }
  };
  App.Health = Health;
  global.Health = Health;   // 供各游戏 newGame 的开局闸门使用

  /* ---------------- 语音引擎选择（侧栏面板） ---------------- */

  function bindVoiceSeg() {
    var btns = document.querySelectorAll('.voice-seg button');
    var sync = function () {
      var cur = Store.getPrefs().voiceEngine || 'auto';
      btns.forEach(function (b) {
        b.classList.toggle('on', b.dataset.ve === cur);
      });
    };
    btns.forEach(function (b) {
      b.addEventListener('click', function () {
        Store.setPrefs({ voiceEngine: b.dataset.ve });
        if (global.Voice) global.Voice.setPreferredEngine(b.dataset.ve);
        sync();
        if (global.Sound) global.Sound.play('select');
        if (global.UI) UI.toast('语音引擎：' + b.textContent);
      });
    });
    sync();
  }

  /* ---------------- 信息抽屉（移动端） ---------------- */

  function bindDrawers() {
    var tabs = document.querySelectorAll('.sidebar-tab');
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        var view = tab.closest('.game-view');
        var sidebar = document.querySelector(tab.dataset.side);
        var open = !sidebar.classList.contains('open');
        sidebar.classList.toggle('open', open);
        view.classList.toggle('drawer-open', open);
        tab.classList.remove('pulse');          // 打开过一次就不再脉冲提醒
        if (global.Sound) global.Sound.play('select');
      });
    });
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

    // 移动端信息抽屉拉手（两个游戏视图各一个）
    bindDrawers();

    // 语音引擎选择（侧栏面板），应用上次偏好
    bindVoiceSeg();
    if (global.Voice) global.Voice.setPreferredEngine(Store.getPrefs().voiceEngine || 'auto');

    // 温馨提醒：进入游戏即记下「记忆时刻」
    Health.remember();

    // 全屏：顶栏按钮 + 移动端建议条
    DOM.btnFullscreen.addEventListener('click', function () {
      toggleFullscreen();
      if (global.Sound) global.Sound.play('select');
    });
    DOM.btnFsGo.addEventListener('click', function () {
      var ok = toggleFullscreen();
      // 稍后确认：仍不在全屏则展开文字指引
      setTimeout(function () {
        if (!fsElement()) showFsTip();
        else { DOM.fsBanner.classList.remove('show'); }
      }, ok ? 600 : 0);
    });
    DOM.btnFsClose.addEventListener('click', function () {
      DOM.fsBanner.classList.remove('show');
      try { localStorage.setItem(FS_HINT_KEY, '1'); } catch (e) { /* 忽略 */ }
    });
    ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (ev) {
      document.addEventListener(ev, function () { syncFsButton(); updateFsBanner(); });
    });
    global.addEventListener('resize', updateFsBanner);
    global.addEventListener('orientationchange', updateFsBanner);
    syncFsButton();
    updateFsBanner();

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
