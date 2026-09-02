/* 斗地主 —— 纯前端单机斗地主游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * ui.js —— 界面渲染与动画
 * 只负责「把状态画出来」，不做任何规则判断。
 * ========================================================================== */
(function (global) {
  'use strict';

  var Cards = global.Cards;

  function el(id) { return document.getElementById(id); }

  var DOM = {};
  function bindDom() {
    ['playArea', 'bottomCards', 'multBadge', 'tableCenter', 'myHand',
      'btnPlay', 'btnPass', 'btnHint', 'btnClear', 'overlay', 'dialog',
      'toast', 'counterGrid', 'infoList', 'logList', 'floatLayer',
      'btnSound', 'btnStats', 'btnHelp', 'lobby'
    ].forEach(function (id) { DOM[id] = el(id); });
    DOM.boxes = [el('box-0'), el('box-1'), el('box-2')];
    DOM.slots = {
      0: document.querySelector('.play-slot[data-seat="0"] .cards'),
      1: document.querySelector('.play-slot[data-seat="1"] .cards'),
      2: document.querySelector('.play-slot[data-seat="2"] .cards')
    };
    DOM.slotWrap = {
      0: document.querySelector('.play-slot[data-seat="0"]'),
      1: document.querySelector('.play-slot[data-seat="1"]'),
      2: document.querySelector('.play-slot[data-seat="2"]')
    };
  }

  /* ---------------- 卡牌元素 ---------------- */

  function cardEl(card, extraCls) {
    var d = document.createElement('div');
    var cls = 'card ';
    if (card.joker) cls += (card.rank === 17 ? 'joker big-joker' : 'joker');
    else cls += (card.red ? 'red' : 'black');
    if (extraCls) cls += ' ' + extraCls;
    d.className = cls;
    d.dataset.id = card.id;

    if (card.joker) {
      d.innerHTML =
        '<div class="corner"><span class="rk">' + (card.rank === 17 ? '大' : '小') +
        '</span><span class="st">王</span></div>' +
        '<div class="big">' + (card.rank === 17 ? '🤴' : '🃏') + '</div>';
    } else {
      d.innerHTML =
        '<div class="corner"><span class="rk">' + Cards.R_SHORT[card.rank] +
        '</span><span class="st">' + card.sym + '</span></div>' +
        '<div class="big">' + card.sym + '</div>';
    }
    return d;
  }

  function backCardEl() {
    var d = document.createElement('div');
    d.className = 'card back';
    return d;
  }

  function miniBacks(n, max) {
    var wrap = document.createElement('div');
    wrap.className = 'mini-cards';
    var show = Math.min(n, max || 12);
    for (var i = 0; i < show; i++) {
      var m = document.createElement('div');
      m.className = 'mini-card';
      wrap.appendChild(m);
    }
    return wrap;
  }

  /* ---------------- 玩家信息框 ---------------- */

  function renderBox(seat, p, state) {
    var box = DOM.boxes[seat];
    if (!box) return;
    var roleCls = p.role === 'landlord' ? 'role-landlord' : (p.role ? 'role-farmer' : '');
    var roleText = p.role === 'landlord' ? '地主' : (p.role === 'farmer' ? '农民' : '');
    var isActive = (state && state.activeSeat === seat);
    var isThinking = (state && state.thinkingSeat === seat);

    box.className = 'player-box' + (isActive ? ' active' : '') + (isThinking ? ' think' : '');
    box.innerHTML =
      '<div class="avatar">' + p.avatar +
      (roleText ? '<span class="role-tag ' + roleCls + '">' + roleText + '</span>' : '') +
      '</div>' +
      '<div class="p-info">' +
      '<div class="p-name">' + p.name + '</div>' +
      '<div class="p-meta">剩 <span class="p-count"><b>' + p.hand.length + '</b></span> 张' +
      (p.bid > 0 ? ' · 叫' + p.bid + '分' : '') +
      (p.doubled === 1 ? ' · 加倍' : (p.doubled === 2 ? ' · 超级加倍' : '')) +
      '</div>' +
      '</div>';

    if (seat !== 0) box.appendChild(miniBacks(p.hand.length));
  }

  /* ---------------- 手牌 ---------------- */

  var onCardClick = null;
  function setCardClickHandler(fn) { onCardClick = fn; }

  var onCardDragEnd = null;
  function setCardDragHandler(fn) { onCardDragEnd = fn; }

  /**
   * 拖动连选：按住任意一张牌横向拖动，划过的所有牌统一选中或取消选中。
   * - 按下的那张若是已选中状态，这次拖动就是「连选取消」，反之是「连选」。
   * - 快速甩动时指针事件会跳过中间的牌，所以每步都把 [上一张, 当前张]
   *   闭区间整段计入，保证"经历的全部牌"都被处理。
   * - 只在原地按下（没划到别的牌）时不干扰，仍按单击处理（选中/取消）。
   */
  var drag = null;              // { pointerId, visited:Set<idx>, lastIdx, mode }
  var clickSuppressed = false;  // 拖动刚结束时吞掉随后而至的 click，避免双触发

  /** 扇形排列的内联 transform（renderHand 与连选取消时都要用同一公式） */
  function fanTransform(i, n) {
    var mid = (n - 1) / 2;
    return 'rotate(' + ((i - mid) * 0.6).toFixed(2) + 'deg) translateY(' +
      (Math.abs(i - mid) * 0.5).toFixed(1) + 'px)';
  }

  function markVisited(i) {
    if (drag.visited.has(i)) return;
    drag.visited.add(i);
    var d = DOM.myHand.children[i];
    if (!d) return;
    if (drag.mode === 'deselect') {
      if (d.classList.contains('selected')) {
        d.classList.remove('selected');
        d.style.transform = fanTransform(i, DOM.myHand.children.length);
        if (global.Sound) global.Sound.play('deselect');
      }
    } else if (!d.classList.contains('selected')) {
      d.style.transform = '';   // 清掉内联扇形角度，让 .selected 的抬牌样式生效
      d.classList.add('selected');
      if (global.Sound) global.Sound.play('select');   // 划牌时有"拨弦"般的反馈
    }
  }

  /**
   * 精确命中：手牌横向叠放（负边距），第 i 张的可见条带是
   * [left_i, left_{i+1})，最后一张到自己的 right —— 直接用 elementFromPoint
   * 会命中最上层（右边的牌），指哪不打哪。这里按每张牌的真实矩形计算，
   * y 方向留出容差（拖动中指针在手牌上下小幅摆动不影响选牌）。
   */
  function cardAtPoint(x, y) {
    var kids = DOM.myHand.children;
    var n = kids.length;
    if (!n) return -1;
    var rects = [];
    var top = Infinity, bottom = -Infinity;
    for (var i = 0; i < n; i++) {
      if (typeof kids[i].getBoundingClientRect !== 'function') return -1;
      var r = kids[i].getBoundingClientRect();
      rects.push(r);
      if (r.top < top) top = r.top;
      if (r.bottom > bottom) bottom = r.bottom;
    }
    if (y < top - 120 || y > bottom + 120) return -1;
    if (x < rects[0].left || x > rects[n - 1].right) return -1;
    for (var k = 0; k < n; k++) {
      var rightEdge = (k === n - 1) ? rects[k].right : rects[k + 1].left;
      if (x >= rects[k].left && x < rightEdge) return k;
    }
    return n - 1;
  }

  function dragMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    var idx = cardAtPoint(e.clientX, e.clientY);
    if (idx < 0) return;
    var from = Math.min(drag.lastIdx, idx), to = Math.max(drag.lastIdx, idx);
    for (var i = from; i <= to; i++) markVisited(i);
    drag.lastIdx = idx;
  }

  function dragEnd(e) {
    if (!drag) return;
    if (e && e.pointerId !== undefined && e.pointerId !== drag.pointerId) return;
    var visited = drag.visited;
    var mode = drag.mode;
    finishDrag();
    if (visited.size <= 1) return;   // 没划到别的牌 → 交给 click 逻辑
    clickSuppressed = true;
    setTimeout(function () { clickSuppressed = false; }, 120);
    if (onCardDragEnd) onCardDragEnd(Array.from(visited).sort(function (a, b) { return a - b; }), mode);
  }

  /** 结束本次拖动并摘掉 document 上的监听（正常松手与强制取消共用） */
  function finishDrag() {
    drag = null;
    document.removeEventListener('pointermove', dragMove);
    document.removeEventListener('pointerup', dragEnd);
    document.removeEventListener('pointercancel', dragEnd);
  }

  function renderHand(cards, selectedIds, interactive) {
    // 手牌重渲染时旧元素全部作废，进行中的拖动必须作废，
    // 否则 stale 索引会操作到新手牌，视觉与 G.selected 失同步
    if (drag) finishDrag();
    DOM.myHand.innerHTML = '';
    DOM.myHand.className = 'hand' + (interactive ? '' : ' disabled');
    var sel = new Set(selectedIds || []);
    cards.forEach(function (c, i) {
      var d = cardEl(c, sel.has(c.id) ? 'selected' : '');
      // 轻微扇形排列，模拟真实持牌手感
      if (!sel.has(c.id)) d.style.transform = fanTransform(i, cards.length);
      if (interactive && onCardClick) {
        d.addEventListener('click', function () {
          if (clickSuppressed) return;
          onCardClick(c, d);
        });
        d.addEventListener('pointerdown', function (e) {
          if (e.button !== undefined && e.button !== 0) return;
          if (drag) return;
          // 按下的牌已选中 → 这一次拖动是「连选取消」，否则是「连选」
          drag = {
            pointerId: e.pointerId, visited: new Set([i]), lastIdx: i,
            mode: d.classList.contains('selected') ? 'deselect' : 'select'
          };
          document.addEventListener('pointermove', dragMove);
          document.addEventListener('pointerup', dragEnd);
          document.addEventListener('pointercancel', dragEnd);
        });
      }
      DOM.myHand.appendChild(d);
    });
  }

  /** 发牌动画：卡牌从牌桌中心飞向各自位置 */
  function dealAnimation(cards) {
    var kids = DOM.myHand.children;
    for (var i = 0; i < kids.length; i++) {
      var d = kids[i];
      d.style.setProperty('--fx', ((i - cards.length / 2) * -14).toFixed(0) + 'px');
      d.style.setProperty('--fy', '-260px');
      d.style.setProperty('--fr', ((i - cards.length / 2) * 3).toFixed(1) + 'deg');
      d.classList.add('dealing');
      d.style.animationDelay = (i * 32) + 'ms';
    }
  }

  /* ---------------- 出牌展示 ---------------- */

  function clearSlot(seat) {
    var w = DOM.slotWrap[seat];
    var old = w.querySelector('.bubble');
    if (old) old.remove();
    DOM.slots[seat].innerHTML = '';
  }

  function clearAllSlots() {
    [0, 1, 2].forEach(clearSlot);
  }

  function bubble(seat, text, cls) {
    var w = DOM.slotWrap[seat];
    var old = w.querySelector('.bubble');
    if (old) old.remove();
    var b = document.createElement('div');
    b.className = 'bubble ' + cls;
    b.textContent = text;
    w.appendChild(b);
    return b;
  }

  function showPlay(seat, cards, combo, opts) {
    opts = opts || {};
    clearSlot(seat);
    var wrap = DOM.slots[seat];
    Cards.sortAsc(cards).forEach(function (c, i) {
      var d = cardEl(c, 'flying');
      d.style.setProperty('--fy', (seat === 0 ? '-90' : '90') + 'px');
      d.style.setProperty('--fx', ((i - cards.length / 2) * -16).toFixed(0) + 'px');
      d.style.animationDelay = (i * 26) + 'ms';
      wrap.appendChild(d);
    });
    if (opts.bomb) {
      bubble(seat, combo.type === Cards.CT.ROCKET ? '王 炸 !' : '炸 弹 !', 'boom');
    }
  }

  function showPass(seat) {
    clearSlot(seat);
    bubble(seat, '不要', 'pass');
  }

  /* ---------------- 底牌 / 倍数 ---------------- */

  function renderBottom(cards, revealed) {
    DOM.bottomCards.innerHTML = '';
    cards.forEach(function (c) {
      DOM.bottomCards.appendChild(revealed ? cardEl(c) : backCardEl());
    });
  }

  function renderMultiplier(base, mult) {
    DOM.multBadge.textContent = '底分 ' + base + ' · 倍数 ×' + mult;
  }

  /* ---------------- 记牌器 ---------------- */

  var COUNTER_RANKS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];

  function renderCounter(played, myHand) {
    var c = new Array(18).fill(0);
    for (var r = 3; r <= 15; r++) c[r] = 4;
    c[16] = 1; c[17] = 1;
    (played || []).forEach(function (x) { if (c[x.rank] > 0) c[x.rank]--; });
    (myHand || []).forEach(function (x) { if (c[x.rank] > 0) c[x.rank]--; });

    var html = '';
    COUNTER_RANKS.forEach(function (r) {
      var n = c[r];
      var isJoker = r >= 16;
      html += '<div class="counter-cell' + (n === 0 ? ' gone' : '') + (isJoker ? ' joker' : '') + '">' +
        '<div class="rk">' + (isJoker ? (r === 16 ? '小王' : '大王') : Cards.R_SHORT[r]) + '</div>' +
        '<div class="ct">' + n + '</div>' +
        '</div>';
    });
    DOM.counterGrid.innerHTML = html;
  }

  /* ---------------- 对局信息 / 日志 ---------------- */

  function renderInfo(rows) {
    DOM.infoList.innerHTML = rows.map(function (r) {
      return '<div class="row"><span>' + r[0] + '</span><b>' + r[1] + '</b></div>';
    }).join('');
  }

  function renderLogs(logs) {
    DOM.logList.innerHTML = logs.slice(-14).map(function (l) {
      return '<div class="' + (l.me ? 'me' : '') + '">' + l.text + '</div>';
    }).join('');
  }

  /* ---------------- 特效 ---------------- */

  var toastTimer = null;
  function toast(msg, ms) {
    DOM.toast.textContent = msg;
    DOM.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      DOM.toast.classList.remove('show');
    }, ms || 1600);
  }

  function bombEffect() {
    var f = document.createElement('div');
    f.className = 'bomb-flash';
    DOM.playArea.appendChild(f);
    DOM.playArea.classList.add('shaking');
    setTimeout(function () {
      f.remove();
      DOM.playArea.classList.remove('shaking');
    }, 520);
  }

  function springBanner(text) {
    var b = document.createElement('div');
    b.className = 'spring-banner';
    b.textContent = text;
    DOM.playArea.appendChild(b);
    setTimeout(function () { b.remove(); }, 1700);
  }

  /* ---------------- 浮层（叫分 / 加倍） ---------------- */

  function floatPanel(title, buttons, hint) {
    closeFloat();
    var p = document.createElement('div');
    p.className = 'float-panel';
    p.id = 'floatPanel';
    var html = '<div class="title">' + title + '</div>';
    if (hint) html += '<div class="hintline">' + hint + '</div>';
    html += '<div class="row"></div>';
    p.innerHTML = html;
    var row = p.querySelector('.row');
    buttons.forEach(function (b) {
      var btn = document.createElement('button');
      btn.className = 'btn ' + (b.cls || '');
      btn.textContent = b.text;
      btn.disabled = !!b.disabled;
      btn.addEventListener('click', function () {
        closeFloat();
        if (b.onClick) b.onClick();
      });
      row.appendChild(btn);
    });
    DOM.floatLayer.appendChild(p);
    return p;
  }

  function closeFloat() {
    var p = el('floatPanel');
    if (p) p.remove();
  }

  /* ---------------- 弹窗 ---------------- */

  /**
   * 弹窗关闭通知：closeDialog 及弹窗按钮触发的真实「打开→关闭」转变
   * 都会回调注册的处理器。按钮路径刻意把通知放在 onClick 之后执行，
   * 这样「再来一局」先切回对局阶段，处理器看到 phase 已不是 over，就不会误回大厅。
   */
  var dialogCloseHandler = null;
  function setDialogCloseHandler(fn) { dialogCloseHandler = fn; }

  function overlayShown() { return DOM.overlay.classList.contains('show'); }

  function hideOverlay() { DOM.overlay.classList.remove('show'); }

  function notifyDialogClosed() {
    if (dialogCloseHandler) dialogCloseHandler();
  }

  function showDialog(html, buttons) {
    DOM.dialog.innerHTML = html;
    var actions = document.createElement('div');
    actions.className = 'actions';
    (buttons || []).forEach(function (b) {
      var btn = document.createElement('button');
      btn.className = 'btn ' + (b.cls || '');
      btn.textContent = b.text;
      btn.addEventListener('click', function () {
        var wasShown = overlayShown();
        if (b.keepOpen !== true) hideOverlay();
        if (b.onClick) b.onClick();
        if (wasShown && b.keepOpen !== true) notifyDialogClosed();
      });
      actions.appendChild(btn);
    });
    DOM.dialog.appendChild(actions);
    DOM.overlay.classList.add('show');
  }

  function closeDialog() {
    var wasShown = overlayShown();
    hideOverlay();
    if (wasShown) notifyDialogClosed();
  }

  /* ---------------- 选场大厅 ---------------- */

  function showLobby() { DOM.lobby.classList.add('show'); }

  function hideLobby() { DOM.lobby.classList.remove('show'); }

  /* ---------------- 操作栏 ---------------- */

  function setActions(cfg) {
    DOM.btnPlay.disabled = !cfg.play;
    DOM.btnPass.disabled = !cfg.pass;
    DOM.btnHint.disabled = !cfg.hint;
    DOM.btnClear.disabled = !cfg.clear;
    DOM.btnPlay.textContent = cfg.playText || '出牌';
    DOM.btnPass.textContent = cfg.passText || '不要';
  }

  /** 大师档整个隐藏提示按钮（其余档只做禁用态切换） */
  function setHintVisible(visible) {
    DOM.btnHint.style.display = visible ? '' : 'none';
  }

  global.UI = {
    bindDom: bindDom, DOM: DOM, el: el,
    cardEl: cardEl, backCardEl: backCardEl,
    renderBox: renderBox, renderHand: renderHand, dealAnimation: dealAnimation,
    setCardClickHandler: setCardClickHandler,
    setCardDragHandler: setCardDragHandler,
    clearSlot: clearSlot, clearAllSlots: clearAllSlots,
    showPlay: showPlay, showPass: showPass, bubble: bubble,
    renderBottom: renderBottom, renderMultiplier: renderMultiplier,
    renderCounter: renderCounter, renderInfo: renderInfo, renderLogs: renderLogs,
    toast: toast, bombEffect: bombEffect, springBanner: springBanner,
    floatPanel: floatPanel, closeFloat: closeFloat,
    showDialog: showDialog, closeDialog: closeDialog,
    setDialogCloseHandler: setDialogCloseHandler,
    showLobby: showLobby, hideLobby: hideLobby,
    setActions: setActions, setHintVisible: setHintVisible
  };

})(typeof window !== 'undefined' ? window : globalThis);
