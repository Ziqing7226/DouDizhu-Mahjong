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
    ['mjView', 'mjHand', 'mjWallInfo', 'mjInfoList', 'mjScoreList', 'mjLogList',
      'mjCounterGrid', 'mjLobby',
      'mjBtnDiscard', 'mjBtnHint', 'mjBtnHu', 'mjBtnGang'
    ].forEach(function (id) { DOM[id] = el(id); });
    DOM.boxes = [el('mjBox-0'), el('mjBox-1'), el('mjBox-2'), el('mjBox-3')];
    DOM.rivers = [el('mjRiver-0'), el('mjRiver-1'), el('mjRiver-2'), el('mjRiver-3')];
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
      '<div class="p-name">' + p.name +
      (state && state.dealer === seat ? ' <span class="dealer-tag">庄</span>' : '') +
      '</div>' +
      '<div class="p-meta">' + wind + '位 · 剩 <b>' + p.hand.length + '</b> 张</div>' +
      '</div>' + meldsHtml(p.melds);
  }

  function meldsHtml(melds) {
    if (!melds || !melds.length) return '';
    var h = '<div class="mj-melds">';
    melds.forEach(function (m) {
      h += '<div class="mj-meld ' + m.type + '">';
      m.tiles.forEach(function (idx) {
        h += '<div class="mtile mini ' + SUIT_CLS[Tiles.suitOf(idx)] + '">' + faceHtml(idx) + '</div>';
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
    // 牌河只展示最近 20 张（5×4），避免遮挡其他区域
    tiles.slice(-20).forEach(function (t) {
      var d = tileEl(t, t.id === lastId ? 'last' : '');
      w.appendChild(d);
    });
  }

  function renderWall(n) {
    DOM.mjWallInfo.textContent = '牌墙余 ' + n + ' 张';
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
    bubble: bubble, clearBubbles: clearBubbles,
    renderCounter: renderCounter, renderInfo: renderInfo,
    renderScore: renderScore, renderLogs: renderLogs,
    setActions: setActions, setHintVisible: setHintVisible,
    showLobby: showLobby, hideLobby: hideLobby, highlightRooms: highlightRooms,
    G: G
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.MjUI;

})(typeof window !== 'undefined' ? window : globalThis);
