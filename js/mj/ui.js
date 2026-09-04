/* 斗地主&麻将 · 棋牌合集 —— 纯前端单机游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * mj/ui.js —— 麻将界面渲染与动画
 * 只负责「把状态画出来」，不做任何规则判断。
 * 通用控件（toast / 浮层 / 弹窗 / 关闭通知）直接复用全局 UI 模块。
 * ========================================================================== */
(function (global) {
  'use strict';

  var Tiles = global.MjTiles;
  var G = global.UI;   // 复用 toast / floatPanel / showDialog 等

  function el(id) { return document.getElementById(id); }

  var DOM = {};
  function bindDom() {
    ['mjView', 'mjTable', 'mjHand', 'mjWallInfo', 'mjInfoList', 'mjScoreList', 'mjLogList',
      'mjCounterGrid', 'mjLobby',
      'mjBtnDiscard', 'mjBtnHint', 'mjBtnHu', 'mjBtnGang'
    ].forEach(function (id) { DOM[id] = el(id); });
    DOM.boxes = [el('mjBox-0'), el('mjBox-1'), el('mjBox-2'), el('mjBox-3')];
    DOM.rivers = [el('mjRiver-0'), el('mjRiver-1'), el('mjRiver-2'), el('mjRiver-3')];
    DOM.melds = [el('mjMelds-0'), el('mjMelds-1'), el('mjMelds-2'), el('mjMelds-3')];
  }

  /* ---------------- 牌元素 ---------------- */

  var SUIT_CLS = { m: 'mj-m', s: 'mj-s', p: 'mj-p', z: 'mj-z' };

  /* ---------- 专业牌面绘制（纯 CSS/SVG，无外部图片） ----------
   * 万：汉字数 + 红色「萬」（传统万子样式）
   * 条：竹节棒排列；一条用 SVG 麻雀
   * 筒：同心圆饼排列（配色按传统蓝/红/绿）
   * 字：東南西北（黑）·中（红）·發（绿）·白（蓝框空板）          */

  var NUM_CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
  var HONOR_FACE = ['東', '南', '西', '北', '中', '發', ''];

  /** 各点数的行排列（1 = 一枚）。
   *  3筒为斜线排列、7筒为「上斜三 + 下四方阵」，用字符串标记走专门绘制；
   *  8筒为两列四行（竖式方阵）。 */
  var DOT_LAYOUT = {
    2: [[1], [1]],
    3: 'diag',
    4: [[1, 1], [1, 1]],
    5: [[1, 1], [1], [1, 1]],
    6: [[1, 1, 1], [1, 1, 1]],
    7: 'seven',
    8: [[1, 1], [1, 1], [1, 1], [1, 1]],
    9: [[1, 1, 1], [1, 1, 1], [1, 1, 1]]
  };
  var DOT_COLORS = {   // 按填充顺序：b 蓝 r 红 g 绿（传统蓝红绿三色）
    2: ['g', 'b'], 4: ['b', 'g', 'g', 'b'],
    5: ['b', 'g', 'r', 'g', 'b'], 6: ['g', 'g', 'g', 'r', 'r', 'r'],
    8: ['b', 'g', 'b', 'g', 'b', 'g', 'b', 'g'],
    9: ['g', 'g', 'g', 'r', 'r', 'r', 'b', 'b', 'b']
  };
  /** 斜排（3筒 / 7筒上半）：蓝-红-绿 */
  var DIAG_COLORS = ['b', 'r', 'g'];
  /** 7筒下半 2×2 的配色 */
  var SEVEN_COLORS = ['g', 'b', 'b', 'g'];
  var BAM_LAYOUT = {
    2: [[1], [1]],
    3: [[1], [1, 1]],
    4: [[1, 1], [1, 1]],
    5: [[1, 1], [1], [1, 1]],
    6: [[1, 1, 1], [1, 1, 1]],
    7: [[1], [1, 1, 1], [1, 1, 1]],
    8: [[1, 1, 1, 1], [1, 1, 1, 1]],
    9: [[1, 1, 1], [1, 1, 1], [1, 1, 1]]
  };
  var BAM_COLORS = {   // 竹节以绿为主，传统红点缀（五条红心、七条红顶）
    2: ['r', 'g'], 3: ['r', 'g', 'g'], 4: ['g', 'g', 'g', 'g'],
    5: ['g', 'g', 'r', 'g', 'g'], 6: ['g', 'g', 'g', 'g', 'g', 'g'],
    7: ['r', 'g', 'g', 'g', 'g', 'g', 'g'], 8: ['g', 'g', 'g', 'g', 'g', 'g', 'g', 'g'],
    9: ['g', 'g', 'g', 'g', 'g', 'g', 'g', 'g', 'g']
  };

  /** 一条的传统「麻雀」：手绘 SVG（蓝身、红顶羽、黄喙、栖枝） */
  var BIRD_SVG =
    '<svg class="bird" viewBox="0 0 44 46" aria-hidden="">' +
    '<path d="M12 26 L-1 15 Q6 14 12 22 Z" fill="#1e8a4c"/>' +
    '<path d="M11 29 L-2 24 Q5 20 12 26 Z" fill="#2fae6a"/>' +
    '<path d="M12 22 L3 8 Q10 9 14 19 Z" fill="#c0392b"/>' +
    '<ellipse cx="20" cy="31" rx="9" ry="11" fill="#2f80c2"/>' +
    '<path d="M16 29 Q9 27 7 21 Q15 23 19 28 Z" fill="#1c5d94"/>' +
    '<circle cx="28" cy="17" r="6" fill="#2f80c2"/>' +
    '<path d="M27 12 Q28 8 32 9 Q30 12 29 13 Z" fill="#c0392b"/>' +
    '<path d="M34 15.5 L41.5 17 L34 19 Z" fill="#e8971e"/>' +
    '<circle cx="29.5" cy="16" r="1.9" fill="#fff"/>' +
    '<circle cx="30" cy="16.3" r="1" fill="#222"/>' +
    '<path d="M19 42 V45.5 M24 42 V45.5" stroke="#e8971e" stroke-width="1.5"/>' +
    '<path d="M11 45.5 H33" stroke="#8a5a2b" stroke-width="2.4" stroke-linecap="round"/>' +
    '</svg>';

  function rowsHtml(layout, colors, cls) {
    var h = '<div class="rows">', k = 0;
    layout.forEach(function (row) {
      h += '<div class="row r' + row.length + '">';
      row.forEach(function (n) {
        if (n) h += '<i class="' + cls + ' c-' + (colors ? colors[k++] : 'g') + '"></i>';
      });
      h += '</div>';
    });
    return h + '</div>';
  }

  /** 斜排三子（3筒、7筒上半） */
  function diagHtml() {
    return '<div class="rows d3">' + DIAG_COLORS.map(function (c) {
      return '<div class="row r1"><i class="dot c-' + c + '"></i></div>';
    }).join('') + '</div>';
  }

  /** 7筒：上斜三 + 下 2×2 方阵 */
  function sevenHtml() {
    return '<div class="g7">' + diagHtml() +
      rowsHtml([[1, 1], [1, 1]], SEVEN_COLORS, 'dot') + '</div>';
  }

  /** 按牌 idx 生成牌面 HTML */
  function faceHtml(idx) {
    if (idx < 9) {
      return '<span class="wn">' + NUM_CN[idx] + '</span><span class="ww">萬</span>';
    }
    if (idx < 18) {
      var n = idx - 9 + 1;                 // 点数 1..9
      if (n === 1) return BIRD_SVG;
      return rowsHtml(BAM_LAYOUT[n], BAM_COLORS[n], 'st');
    }
    if (idx < 27) {
      var m = idx - 18 + 1;                // 点数 1..9
      if (m === 1) return '<div class="d1"></div>';   // 一筒：大同心圆
      if (m === 3) return diagHtml();
      if (m === 7) return sevenHtml();
      return rowsHtml(DOT_LAYOUT[m], DOT_COLORS[m], 'dot');
    }
    var h = idx - 27;
    if (h === 6) return '<span class="bai"></span>';  // 白板
    return '<span class="hon' + (h === 4 ? ' hr' : (h === 5 ? ' hg' : '')) + '">' +
      HONOR_FACE[h] + '</span>';
  }

  function tileEl(tile, extraCls) {
    var d = document.createElement('div');
    var idx = (typeof tile === 'number') ? tile : tile.idx;
    var cls = 'mtile ' + SUIT_CLS[Tiles.suitOf(idx)];
    if (extraCls) cls += ' ' + extraCls;
    d.className = cls;
    d.dataset.idx = idx;
    if (typeof tile === 'object') d.dataset.id = tile.id;
    d.innerHTML = faceHtml(idx);
    return d;
  }

  /** 把一组 idx 渲染成小牌面 HTML 字符串（结算亮牌等场景用） */
  function tilesHtml(idxs, extraCls) {
    return (idxs || []).map(function (i) {
      return '<div class="mtile mini ' + SUIT_CLS[Tiles.suitOf(i)] +
        (extraCls ? ' ' + extraCls : '') + '">' + faceHtml(i) + '</div>';
    }).join('');
  }

  function backEl() {
    var d = document.createElement('div');
    d.className = 'mtile back';
    return d;
  }

  /* ---------------- 座位信息框 ---------------- */

  var WIND = ['东', '南', '西', '北'];

  /* 座位框常显：头像 + 名字 + 剩牌数 + 副露始终可见（手机端由 CSS 压缩，
   * 名字超长时横向省略号截断，不再「默认折叠成头像、点按临时展开」） */
  function renderSeat(seat, p, state) {
    var box = DOM.boxes[seat];
    if (!box) return;
    var isActive = state && state.activeSeat === seat;
    var isThinking = state && state.thinkingSeat === seat;
    var wind = WIND[(seat - (state ? state.dealer : 0) + 4) % 4];   // 相对庄家的风位显示

    box.className = 'mj-seat mj-seat-' + seat +
      (isActive ? ' active' : '') + (isThinking ? ' think' : '');
    box.innerHTML =
      '<div class="avatar">' + p.avatar + '</div>' +
      '<div class="p-info">' +
      '<div class="p-name">' +
      (state && state.dealer === seat ? '<span class="dealer-tag">庄</span>' : '') +
      p.name +
      '</div>' +
      '<div class="p-meta">' + wind + '位 · 剩 <b>' + p.hand.length + '</b> 张</div>' +
      '<span class="cnt-badge">剩' + p.hand.length + '张</span>' +
      '</div>';
    syncTurnClock(seat);
  }

  /** 副露条：四家副露各自贴在牌河末端（不再塞进座位框），归谁的一目了然 */
  function renderMelds(seat, melds) {
    var strip = DOM.melds && DOM.melds[seat];
    if (!strip) return;
    strip.innerHTML = meldsHtml(melds, seat);
  }

  /* ---------------- 回合倒计时环 ----------------
   * 行动方「座位信息框」外圈的 30 秒红色圆角矩形进度环，与斗地主共用视觉。
   * viewBox 按框实际像素 1:1 绘制（环贴框、圆角不变形），
   * pathLength=100 归一化进度，注入即落位当前进度。 */

  var clock = null;   // { seat, endsAt, total, explicit, iv, els:{box,svg,prg} }

  /** 按座位框实际像素画圆角矩形路径 */
  function ringPathFor(box) {
    var r = box.getBoundingClientRect();
    var w = Math.max(20, Math.round(r.width) + 10);
    var h = Math.max(20, Math.round(r.height) + 10);
    var rad = Math.min(14, h / 2, w / 2);
    return 'M' + (w / 2) + ' 0 H' + (w - rad) +
      ' A' + rad + ' ' + rad + ' 0 0 1 ' + w + ' ' + rad +
      ' V' + (h - rad) +
      ' A' + rad + ' ' + rad + ' 0 0 1 ' + (w - rad) + ' ' + h +
      ' H' + rad +
      ' A' + rad + ' ' + rad + ' 0 0 1 0 ' + (h - rad) +
      ' V' + rad +
      ' A' + rad + ' ' + rad + ' 0 0 1 ' + rad + ' 0 H' + (w / 2) + ' Z';
  }

  function setTurnClock(seat, totalSec) {
    clearTurnClock();
    clock = {
      seat: seat,
      total: totalSec,
      endsAt: Date.now() + totalSec * 1000,
      explicit: null,       // 我方回合由游戏每秒喂入与按钮一致的真实秒数
      iv: null,
      els: null
    };
    clock.iv = setInterval(clockTick, 1000);
    injectTurnClock(DOM.boxes[seat]);
    clockTick();
  }

  /** 游戏层每秒喂入我方真实剩余秒数（环的消耗速率与按钮倒计时同步）。
   *  只同步「我方座位」的环：AI 回合的环走墙钟。 */
  function tickTurnClock(leftSec) {
    if (!clock || clock.seat !== 0) return;
    clock.explicit = leftSec;
    clockTick();
  }

  function clearTurnClock() {
    if (!clock) return;
    if (clock.iv) clearInterval(clock.iv);
    if (clock.els && clock.els.svg) clock.els.svg.remove();
    clock = null;
  }

  /** 当前进度对应的 dashoffset（注入前先算好，落位即正确值，不播放过渡动画） */
  function ringOffsetNow() {
    var left = clock.explicit != null
      ? clock.explicit
      : (clock.endsAt - Date.now()) / 1000;
    if (left < 0) left = 0;
    var frac = clock.total > 0 ? left / clock.total : 0;
    return (100 * (1 - frac)).toFixed(1);
  }

  /** 座位框实际像素尺寸（读不到布局时用标称值兜底） */
  function ringDims(box) {
    var w = 110, h = 70;
    try {
      var r = box.getBoundingClientRect();
      if (r && r.width > 0) w = Math.max(20, Math.round(r.width) + 10);
      if (r && r.height > 0) h = Math.max(20, Math.round(r.height) + 10);
    } catch (e) { /* 忽略 */ }
    return { w: w, h: h };
  }

  /** 按尺寸画圆角矩形路径，从顶部中点顺时针一整圈 */
  function ringPathFor(w, h) {
    var rad = Math.min(14, h / 2, w / 2);
    return 'M' + (w / 2) + ' 0 H' + (w - rad) +
      ' A' + rad + ' ' + rad + ' 0 0 1 ' + w + ' ' + rad +
      ' V' + (h - rad) +
      ' A' + rad + ' ' + rad + ' 0 0 1 ' + (w - rad) + ' ' + h +
      ' H' + rad +
      ' A' + rad + ' ' + rad + ' 0 0 1 0 ' + (h - rad) +
      ' V' + rad +
      ' A' + rad + ' ' + rad + ' 0 0 1 ' + rad + ' 0 H' + (w / 2) + ' Z';
  }

  function injectTurnClock(box) {
    if (!clock || !box) return;
    if (clock.els && clock.els.svg) clock.els.svg.remove();   // 旧环可能挂在别的框上
    var svgNS = 'http://www.w3.org/2000/svg';
    var mkSVG = document.createElementNS
      ? function (t) { return document.createElementNS(svgNS, t); }
      : function (t) { return document.createElement(t); };   // 无 DOM 桩兜底

    var dim = ringDims(box);
    var svg = mkSVG('svg');
    svg.setAttribute('viewBox', '0 0 ' + dim.w + ' ' + dim.h);
    svg.setAttribute('class', 'turn-ring');
    var trk = mkSVG('path');
    trk.setAttribute('d', ringPathFor(dim.w, dim.h));
    trk.setAttribute('pathLength', '100');
    trk.setAttribute('class', 'trk');
    var prg = mkSVG('path');
    prg.setAttribute('d', ringPathFor(dim.w, dim.h));
    prg.setAttribute('pathLength', '100');
    prg.setAttribute('class', 'prg');
    prg.style.strokeDasharray = '100';
    prg.style.strokeDashoffset = ringOffsetNow();   // 落位即当前进度
    svg.appendChild(trk);
    svg.appendChild(prg);

    box.appendChild(svg);
    clock.els = { box: box, svg: svg, prg: prg };
  }

  function clockTick() {
    if (!clock) return;
    var left = clock.explicit != null
      ? clock.explicit
      : (clock.endsAt - Date.now()) / 1000;
    if (left < 0) left = 0;
    var frac = clock.total > 0 ? left / clock.total : 0;
    if (clock.els && clock.els.prg) {
      clock.els.prg.style.strokeDashoffset = (100 * (1 - frac)).toFixed(1);
    }
  }

  /** renderSeat 每次整体重绘座位后调用：倒计时还挂着就得把环重新补上 */
  function syncTurnClock(seat) {
    if (!clock || clock.seat !== seat) return;
    var box = DOM.boxes[seat];
    if (!box) return;
    if (clock.els && clock.els.box === box && box.querySelector('.turn-ring')) return;
    injectTurnClock(box);
  }

  /** 副露渲染。中国麻将惯例：碰/杠/吃进来的那张牌横放，标明从哪家拿的。
   *  位置按来源排：上家的横牌放最左、对家放中间、下家放最右（暗杠无来源不标）。 */
  function meldsHtml(melds, seat) {
    if (!melds || !melds.length) return '';
    var h = '<div class="mj-melds">';
    melds.forEach(function (m) {
      h += '<div class="mj-meld ' + m.type + '">';
      var claimedPos = -1;
      if (seat != null && m.from != null && m.from !== seat) {
        if (m.type === 'chi') {
          claimedPos = m.tiles.indexOf(m.claimedIdx);
        } else {
          var rel = (m.from - seat + 4) % 4;          // 1=下家 2=对家 3=上家
          var n = m.tiles.length;
          claimedPos = rel === 3 ? 0 : (rel === 1 ? n - 1 : Math.floor((n - 1) / 2));
        }
        if (claimedPos < 0 || claimedPos >= m.tiles.length) claimedPos = -1;
      }
      m.tiles.forEach(function (idx, i) {
        h += '<div class="mtile mini' + (i === claimedPos ? ' claimed' : '') + ' ' +
          SUIT_CLS[Tiles.suitOf(idx)] + '">' + faceHtml(idx) + '</div>';
      });
      h += '</div>';
    });
    return h + '</div>';
  }

  /* ---------------- 手牌 ---------------- */

  var onTileClick = null;
  function setTileClickHandler(fn) { onTileClick = fn; }

  function renderHand(tiles, selectedId, interactive) {
    DOM.mjHand.innerHTML = '';
    DOM.mjHand.className = 'mj-hand' + (interactive ? '' : ' disabled');
    tiles.forEach(function (t) {
      var d = tileEl(t, t.id === selectedId ? 'selected' : '');
      if (interactive && onTileClick) {
        d.addEventListener('click', function () { onTileClick(t, d); });
      }
      DOM.mjHand.appendChild(d);
    });
  }

  function dealAnimation() {
    var kids = DOM.mjHand.children;
    for (var i = 0; i < kids.length; i++) {
      kids[i].style.animationDelay = (i * 24) + 'ms';
      kids[i].classList.add('dealing');
    }
  }

  /* ---------------- 牌河 / 牌墙 ---------------- */

  function renderRiver(seat, tiles, lastId) {
    var w = DOM.rivers[seat];
    if (!w) return;
    w.innerHTML = '';
    // 定格最近 18 张（6×3）：面积恒定，杜绝堆叠与外溢（更早的弃牌不再展示）
    // 牌面朝向由 CSS 按河位统一旋转（全部头朝桌心，各家读起来是正的）。
    var vertical = (seat === 1 || seat === 3);
    tiles.slice(-18).forEach(function (t) {
      var d = tileEl(t, t.id === lastId ? 'last' : '');
      if (!vertical) { w.appendChild(d); return; }
      var cell = document.createElement('div');
      cell.className = 'rv-cell';
      cell.appendChild(d);
      w.appendChild(cell);
    });
  }

  function renderWall(n, rounds) {
    DOM.mjWallInfo.textContent = '牌墙余 ' + n + ' 张' +
      (rounds ? ' · 第 ' + rounds + ' 巡' : '');
    // 亮牌上桌期间保持隐藏（renderAll 在结算后仍会调用本函数）
    DOM.mjWallInfo.style.display = handsShown ? 'none' : '';
  }

  /** 局终亮牌：各家手牌亮到牌桌上「贴近各自边缘」的一侧，方向与各家牌河一致；
   *  牌河向桌心让位（加 reveal-shift 类）。我方手牌在手牌区本就可见，不重复。
   *  结算期同时隐藏中央牌墙指示避免争位；牌留在桌上直到下一局。 */
  var handsShown = false;
  function showTableHands(hands) {
    hideTableHands();
    handsShown = true;
    if (global.document && global.document.body) global.document.body.classList.add('reveal-mode');
    DOM.mjWallInfo.style.display = 'none';
    for (var s = 1; s <= 3; s++) {
      var rv = DOM.rivers && DOM.rivers[s];
      if (rv) rv.classList.add('reveal-shift');
    }
    if (DOM.melds) {
      for (var m = 1; m <= 3; m++) {
        if (DOM.melds[m]) DOM.melds[m].classList.add('reveal-shift');
      }
    }
    (hands || []).forEach(function (item) {
      if (item.seat === 0 || !item.tiles || !item.tiles.length) return;
      var wrap = document.createElement('div');
      wrap.className = 'remain-tiles remain-mj-' + item.seat;
      // tiles 为手牌对象数组 {idx,id}；tileEl 兼容纯 idx，两种口径都能出牌面
      Tiles.sortTiles(item.tiles.slice()).forEach(function (t) {
        var el = tileEl(t);
        el.classList.add('remain-mj');
        wrap.appendChild(el);
      });
      DOM.mjTable.appendChild(wrap);
    });
  }

  function hideTableHands() {
    handsShown = false;
    if (global.document && global.document.body) global.document.body.classList.remove('reveal-mode');
    var old = DOM.mjTable ? DOM.mjTable.querySelectorAll('.remain-tiles') : [];
    for (var i = 0; i < old.length; i++) old[i].remove();
    for (var s = 1; s <= 3; s++) {
      var rv = DOM.rivers && DOM.rivers[s];
      if (rv) rv.classList.remove('reveal-shift');
    }
    if (DOM.melds) {
      for (var m = 1; m <= 3; m++) {
        if (DOM.melds[m]) DOM.melds[m].classList.remove('reveal-shift');
      }
    }
    if (DOM.mjWallInfo) DOM.mjWallInfo.style.display = '';
  }

  /* ---------------- 气泡 ---------------- */

  function bubble(seat, text, cls) {
    var box = DOM.boxes[seat];
    if (!box) return;
    var old = box.querySelector('.mj-bubble');
    if (old) old.remove();
    var b = document.createElement('div');
    b.className = 'mj-bubble ' + (cls || '');
    b.textContent = text;
    box.appendChild(b);
    setTimeout(function () { b.remove(); }, 1600);
  }

  function clearBubbles() {
    DOM.boxes.forEach(function (box) {
      if (!box) return;
      var old = box.querySelector('.mj-bubble');
      if (old) old.remove();
    });
  }

  /* ---------------- 侧栏 ---------------- */

  /** 余牌器：34 种牌各剩几张（不可见的 = 4 − 我的暗牌 − 牌河 − 副露明牌） */
  var COUNTER_ORDER = (function () {
    var arr = [];
    for (var i = 0; i < 34; i++) arr.push(i);
    return arr;
  })();

  function renderCounter(unseen) {
    var html = '';
    COUNTER_ORDER.forEach(function (i) {
      var n = unseen[i];
      var honor = i >= 27;
      html += '<div class="counter-cell' + (n === 0 ? ' gone' : '') + (honor ? ' joker' : '') + '">' +
        '<div class="rk">' + (honor ? Tiles.HONOR_SHORT[i - 27]
          : (i % 9 + 1) + Tiles.SUIT_NAME[Tiles.suitOf(i)]) + '</div>' +
        '<div class="ct">' + n + '</div></div>';
    });
    DOM.mjCounterGrid.innerHTML = html;
  }

  function renderInfo(rows) {
    DOM.mjInfoList.innerHTML = rows.map(function (r) {
      return '<div class="row"><span>' + r[0] + '</span><b>' + r[1] + '</b></div>';
    }).join('');
  }

  function renderScore(rows) {
    DOM.mjScoreList.innerHTML = rows.map(function (r) {
      var cls = r[1] > 0 ? 'plus' : (r[1] < 0 ? 'minus' : '');
      return '<div class="row"><span>' + r[0] + '</span><b class="' + cls + '">' +
        (r[1] > 0 ? '+' : '') + r[1] + '</b></div>';
    }).join('');
  }

  function renderLogs(logs) {
    DOM.mjLogList.innerHTML = logs.slice(-14).map(function (l) {
      return '<div class="' + (l.me ? 'me' : '') + '">' + l.text + '</div>';
    }).join('');
  }

  /* ---------------- 操作按钮 ---------------- */

  function setActions(cfg) {
    var map = {
      mjBtnDiscard: cfg.discard, mjBtnHint: cfg.hint,
      mjBtnHu: cfg.hu, mjBtnGang: cfg.gang
    };
    Object.keys(map).forEach(function (id) {
      var b = DOM[id];
      if (!b) return;
      b.disabled = !map[id];
    });
  }

  /** 大师档隐藏提示按钮 */
  function setHintVisible(visible) {
    DOM.mjBtnHint.style.display = visible ? '' : 'none';
  }

  /* ---------------- 选场大厅 ---------------- */

  function showLobby() { DOM.mjLobby.classList.add('show'); }
  function hideLobby() { DOM.mjLobby.classList.remove('show'); }

  function highlightRooms(diff) {
    var btns = DOM.mjLobby.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('last', btns[i].dataset.d === diff);
    }
  }

  global.MjUI = {
    bindDom: bindDom, DOM: DOM, el: el,
    tileEl: tileEl, tilesHtml: tilesHtml, backEl: backEl,
    faceHtml: faceHtml,
    renderSeat: renderSeat, renderHand: renderHand, dealAnimation: dealAnimation,
    setTileClickHandler: setTileClickHandler,
    renderRiver: renderRiver, renderWall: renderWall,
    renderMelds: renderMelds,
    showTableHands: showTableHands, hideTableHands: hideTableHands,
    bubble: bubble, clearBubbles: clearBubbles,
    renderCounter: renderCounter, renderInfo: renderInfo,
    renderScore: renderScore, renderLogs: renderLogs,
    setActions: setActions, setHintVisible: setHintVisible,
    seatWind: function (seat, dealer) { return WIND[(seat - (dealer || 0) + 4) % 4]; },
    setTurnClock: setTurnClock, tickTurnClock: tickTurnClock, clearTurnClock: clearTurnClock,
    showLobby: showLobby, hideLobby: hideLobby, highlightRooms: highlightRooms,
    G: G
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.MjUI;

})(typeof window !== 'undefined' ? window : globalThis);
