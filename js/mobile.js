/* 斗地主 —— 纯前端单机斗地主游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * mobile.js —— 移动端适配
 * 手机浏览器上：
 *   · 竖屏时显示「请横屏」提示层，引导用户旋转手机；
 *   · 横屏时把 1000px 宽的桌面布局整体等比缩放到视口宽度，
 *     并按视口比例拉高 #app（牌桌中央区自动吃掉多余高度），
 *     使画面恰好铺满整块横屏 —— 即「横屏显示 + 自适应屏幕比例」。
 * 桌面浏览器完全不受影响（不做任何缩放）。
 * 调试：任意浏览器加 ?mobile=1 可强制启用移动布局，?mobile=0 强制关闭。
 * ========================================================================== */
(function (global) {
  'use strict';

  /* 测试桩 / 非浏览器环境直接跳过（无 navigator、无视口尺寸） */
  var nav = global.navigator;
  if (!nav || !global.document || typeof global.innerWidth !== 'number') return;

  /* ---------------- 移动端判定 ---------------- */

  var ua = nav.userAgent || '';
  var touch = ('ontouchstart' in global) || (nav.maxTouchPoints || 0) > 1;
  var uaMobile = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(ua);
  // iPadOS 13+ 的 Safari 默认报 Macintosh 桌面 UA，靠多点触控识别
  var iPadOS = /Macintosh/i.test(ua) && (nav.maxTouchPoints || 0) > 1;

  var forced = null;
  try {
    var q = new URLSearchParams(global.location.search);
    if (q.get('mobile') === '1') forced = true;
    else if (q.get('mobile') === '0') forced = false;
  } catch (e) { /* 老浏览器无 URLSearchParams 就只靠 UA */ }

  var isMobile = forced !== null ? forced : (touch && (uaMobile || iPadOS));

  /* ---------------- 等比缩放适配 ---------------- */

  // 与 #app 的 min-width 一致；高度取桌面布局的舒适最小值
  var DESIGN_W = 1000;
  var DESIGN_H = 520;
  // 手机端布局放大后的内容最小高度（顶栏+牌桌各行+手牌+操作栏），
  // 缩放必须同时保证这个高度放得下，否则底部手牌会被裁掉
  var DESIGN_H_M = 560;

  var app = null, body = null;

  function reset() {
    app.style.width = '';
    app.style.height = '';
    app.style.transform = '';
    app.style.transformOrigin = '';
    app.style.position = '';
    app.style.left = '';
    app.style.top = '';
  }

  function fit() {
    if (!app) return;
    if (!isMobile) { body.classList.remove('portrait'); reset(); return; }

    var vw = global.innerWidth;
    var vh = global.innerHeight;
    var portrait = vh > vw;
    body.classList.toggle('portrait', portrait);
    if (portrait) { reset(); return; }   // 竖屏：交给「请横屏」提示层

    if (vw >= DESIGN_W) { reset(); return; }   // 大屏横铺足够，无需缩放

    // 同时满足宽度（1000 设计稿）与高度（560 手机内容最小高），
    // 取更小的缩放，保证纵向不被裁切；多出的宽度转化为更宽的牌桌
    var scale = Math.min(vw / DESIGN_W, vh / DESIGN_H_M);
    var appW = Math.round(vw / scale);
    var appH = Math.round(vh / scale);
    app.style.width = appW + 'px';
    app.style.height = appH + 'px';
    app.style.transform = 'scale(' + scale + ')';
    app.style.transformOrigin = '0 0';
    app.style.position = 'absolute';
    app.style.left = '0';
    app.style.top = '0';
  }

  function init() {
    app = global.document.getElementById('app');
    if (!app) return;
    body = global.document.body;
    if (isMobile) body.classList.add('is-mobile');
    fit();

    var deb = null;
    var onResize = function () {
      clearTimeout(deb);
      deb = setTimeout(fit, 80);
    };
    global.addEventListener('resize', onResize);
    global.addEventListener('orientationchange', onResize);
    if (global.visualViewport) global.visualViewport.addEventListener('resize', onResize);
    // 兜底：模拟器 / 分屏 / 工具栏收展等场景下 window resize 可能不触发，
    // 直接观察根元素尺寸变化最稳
    if (global.ResizeObserver) {
      new ResizeObserver(onResize).observe(global.document.documentElement);
    }
  }

  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.Mobile = {
    isMobile: function () { return isMobile; },
    fit: fit
  };

})(typeof window !== 'undefined' ? window : globalThis);
