/* 斗地主&麻将 · 棋牌合集 —— 纯前端单机游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * mj/game.js —— 麻将对局主流程（发牌 → 摸牌/打牌循环 → 副露抢牌 → 胡牌结算）
 * 座位约定：0 = 玩家（下方），1 = 右侧 AI，2 = 上方 AI，3 = 左侧 AI
 * 行牌顺序：0 → 1 → 2 → 3 → 0（逆时针）
 * 与斗地主 game.js 同构：局次令牌丢弃旧局回调、选场大厅、局终弹窗返回大厅、
 * 「再来一局」保持对手、「换个场次/关弹窗」换新对手。
 * ========================================================================== */
(function (global) {
  'use strict';

  var Tiles = global.MjTiles;
  var Rules = global.MjRules;
  var AI = global.MjAI;
  var MjUI = global.MjUI;
  var UI = global.UI;          // 通用 toast / floatPanel / showDialog
  var Sound = global.Sound;
  var Store = global.Store;
  var Bgm = global.Bgm;

  var TURN_SECONDS = 30;

  var G = {
    phase: 'lobby',        // lobby | playing | over
    gen: 0,                // 局次令牌：每开新局 +1，用于丢弃上一局的遗留回调
    players: [],           // { seat,name,avatar,isAI,hand:[tile],melds:[],river:[],delta }
    wall: [],              // 牌墙（前端摸牌，尾端留给杠）
    dealer: 0,             // 庄家座位
    turn: 0,
    difficulty: 'hard',
    lastDiscard: null,     // { seat, tile } 当前待响应的弃牌
    activeClaim: null,     // { queue, fromSeat } 玩家争抢浮层挂起时的现场
    logs: [],
    selected: null,        // 我的手牌选中的 tile 对象
    nextOpponents: null,   // 下一次开局使用的对手（回大厅刷新；再来一局保持）
    busy: false,
    pendingTurn: false,    // 吃/碰/杠成立后到补发行牌回合落地前禁止交互（防窗口内提前打出）
    timer: null,
    timeLeft: 0,
    thinkingSeat: -1,
    drawCount: 0
  };

  /* ================= 工具 ================= */

  function P(seat) { return G.players[seat]; }

  /**
   * 带「局次令牌」的延时调用：一旦开了新局，上一局遗留的回调会被直接丢弃。
   * 同时登记待执行队列，由 800ms 心跳兜底（移动端后台冻结 setTimeout 时，
   * 回到前台立即补跑超期任务），与斗地主 game.js 同构。
   */
  var __rawSetTimeout = global.setTimeout;
  var pendingTasks = [];
  function runTask(t) {
    if (t.done) return;
    t.done = true;
    if (G.gen !== t.gen) return;
    t.fn();
  }
  function later(ms, fn) {
    var gen = G.gen;
    var task = { at: Date.now() + ms, gen: gen, fn: fn, done: false };
    pendingTasks.push(task);
    if (pendingTasks.length > 300) {
      pendingTasks = pendingTasks.filter(function (x) { return !x.done; });
    }
    return __rawSetTimeout(function () { runTask(task); }, ms);
  }
  setInterval(function () {
    var now = Date.now();
    for (var i = 0; i < pendingTasks.length; i++) {
      if (!pendingTasks[i].done && pendingTasks[i].at <= now) runTask(pendingTasks[i]);
    }
  }, 800);

  function meldBudget(p) { return 4 - p.melds.length; }
  function isDealer(seat) { return seat === G.dealer; }

  function log(text, me) {
    G.logs.push({ text: text, me: !!me });
    MjUI.renderLogs(G.logs);
  }

  /**
   * 对 viewer 座位而言「看不到」的各牌张数：
   * 自己的暗牌 + 全部牌河 + 明副露（自己的暗杠自己也看得见，同样扣除）
   */
  function unseenCounts(viewer) {
    var v = viewer || 0;
    var u = new Array(34).fill(4);
    if (G.players.length === 4) {
      G.players[v].hand.forEach(function (t) { u[t.idx]--; });
      G.players.forEach(function (p) {
        p.river.forEach(function (t) { u[t.idx]--; });
        p.melds.forEach(function (m) {
          if (m.type !== 'angang' || p.seat === v) {
            m.tiles.forEach(function (i) { u[i]--; });
          }
        });
      });
    }
    return u;
  }

  function countsOfHand(seat) { return Tiles.countsOf(P(seat).hand); }

  /** 某家是否可能有敌意听牌（用于防守判断）：
   *  大师档为完全信息 —— 直接精确判定他家是否真的听牌；
   *  其余档用启发式（暗牌很少或有大量副露）。 */
  function opponentTenpaiish(seat) {
    for (var i = 0; i < 4; i++) {
      if (i === seat) continue;
      var p = P(i);
      if (G.difficulty === 'master') {
        if (Rules.shanten(Tiles.countsOf(p.hand), meldBudget(p)) === 0) return true;
        continue;
      }
      var estimate = p.hand.length + p.melds.length * 3;
      if (estimate <= 13 && p.hand.length <= 5) return true;
    }
    return false;
  }

  function renderAll() {
    var st = {
      activeSeat: (G.phase === 'playing') ? G.turn : -1,
      thinkingSeat: G.thinkingSeat,
      dealer: G.dealer
    };
    var lastId = G.lastDiscard ? G.lastDiscard.tile.id : null;
    for (var s = 0; s < 4; s++) {
      MjUI.renderSeat(s, P(s), st);
      MjUI.renderRiver(s, P(s).river, lastId);
      MjUI.renderMelds(s, P(s).melds);
    }
    MjUI.renderWall(G.wall.length, G.drawCount);
    MjUI.renderCounter(unseenCounts());
    updateInfo();
    updateScore();
  }

  function renderHand() {
    var my = P(0);
    var myDiscard = canDiscardNow();
    MjUI.renderHand(Tiles.sortTiles(my.hand.slice()), G.selected ? G.selected.id : null, myDiscard);
  }

  function updateInfo() {
    MjUI.renderInfo([
      ['难度', AI.CFG[G.difficulty].name],
      ['庄家', P(G.dealer).name],
      ['底分', 100],
      ['牌墙余牌', G.wall.length + ' 张'],
      ['行牌进度', '第 ' + G.drawCount + ' 巡']
    ]);
  }

  function updateScore() {
    MjUI.renderScore(G.players.map(function (p) {
      return [p.name + (isDealer(p.seat) ? '（庄）' : ''), p.delta || 0];
    }));
  }

  /* ================= 对手网名 ================= */

  var NAME_HEADS = ['稳重的', '嘿嘿笑的', '爱杠牌的', '缺一门', '摸牌快', '只想清一色',
    '喜欢碰', '神算子', '老雀头', '隔壁桌', '刚胡完', '连庄中', '点炮王', '截胡专业',
    '末位翻盘', '不太会打', '自称高手', '低调听牌', '手感火热', '输了不认'];
  var NAME_TAILS = ['张阿姨', '李大爷', '小方块', '二筒', '红中哥', '发财姐', '白板兄',
    '九万', '一条', '老周', '阿宝', '翠花', '石头', '芝麻', '汤圆', '豆腐'];
  var OPP_AVATARS = ['🎎', '🀫', '🐈', '🐕', '🦜', '🍵', '🧧', '🏮', '🪑', '🫖',
    '👴', '👵', '🧑', '👨', '👩', '🐲'];

  function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

  function makeOpponent(excludeNames) {
    var name = '', guard = 0;
    do {
      name = pick(NAME_HEADS) + pick(NAME_TAILS);
    } while (excludeNames && excludeNames.indexOf(name) >= 0 && guard++ < 30);
    return { name: name, avatar: pick(OPP_AVATARS) };
  }

  function rollOpponents() {
    var a = makeOpponent(null);
    var b = makeOpponent([a.name]);
    var c = makeOpponent([a.name, b.name]);
    G.nextOpponents = [a, b, c];
    return G.nextOpponents;
  }

  /* ================= 选场大厅 ================= */

  function enterLobby() {
    G.gen++;
    clearTimer();
    MjUI.clearTurnClock();
    UI.hideRecall();
    G.settleHtml = null;
    G.phase = 'lobby';
    G.thinkingSeat = -1;
    G.busy = false;
    G.pendingTurn = false;
    G.lastDiscard = null;
    G.activeClaim = null;
    G.selected = null;
    rollOpponents();
    UI.closeFloat();
    UI.closeDialog();
    MjUI.clearBubbles();
    setActions({ discard: false, hint: false, hu: false, gang: false });
    MjUI.highlightRooms(G.difficulty);
    MjUI.showLobby();
    if (G.players.length === 4) renderAll();
  }

  /** 切回游戏模式大厅时暂停当前局面 */
  function suspend() {
    G.gen++;
    clearTimer();
    MjUI.clearTurnClock();
    UI.hideRecall();
    G.settleHtml = null;
    G.phase = 'lobby';
    G.thinkingSeat = -1;
    G.busy = false;
    G.pendingTurn = false;
    G.activeClaim = null;
    MjUI.hideLobby();
    UI.closeFloat();
    MjUI.clearBubbles();
    setActions({ discard: false, hint: false, hu: false, gang: false });
  }

  /* ================= 开局 ================= */

  function newGame() {
    // 温馨提醒闸门：连续游玩超半小时 → 先弹休息提醒，确认后再开局
    if (global.Health && global.Health.gate(function () { newGame(); })) return;
    G.gen++;
    clearTimer();
    MjUI.clearTurnClock();
    UI.hideRecall();
    G.settleHtml = null;
    AI.resetCache();
    UI.closeFloat();
    UI.closeDialog();
    MjUI.clearBubbles();
    MjUI.hideLobby();

    var deck = Tiles.shuffle(Tiles.makeDeck());
    var opp = G.nextOpponents || rollOpponents();
    G.players = [
      { seat: 0, name: '我', avatar: '🙂', isAI: false, hand: [], melds: [], river: [], delta: 0, draws: 0 },
      { seat: 1, name: opp[0].name, avatar: opp[0].avatar, isAI: true, hand: [], melds: [], river: [], delta: 0, draws: 0 },
      { seat: 2, name: opp[1].name, avatar: opp[1].avatar, isAI: true, hand: [], melds: [], river: [], delta: 0, draws: 0 },
      { seat: 3, name: opp[2].name, avatar: opp[2].avatar, isAI: true, hand: [], melds: [], river: [], delta: 0, draws: 0 }
    ];
    for (var s = 0; s < 4; s++) G.players[s].hand = deck.splice(0, 13).map(function (t) {
      return { id: t.id, idx: t.idx, suit: t.suit, label: t.label, short: t.short };
    });
    G.wall = deck;
    G.dealer = (Math.random() * 4) | 0;
    G.turn = G.dealer;
    G.lastDiscard = null;
    G.selected = null;
    G.logs = [];
    G.busy = false;
    G.pendingTurn = false;
    G.drawCount = 0;
    G.phase = 'playing';

    for (var r = 0; r < 4; r++) MjUI.renderRiver(r, [], null);
    MjUI.renderHand([], null, false);
    MjUI.dealAnimation();
    Sound.play('deal');
    renderAll();
    renderHand();
    log('—— 新的一局：' + P(G.dealer).name + ' 坐庄 ——');

    later(1000, function () { nextTurn({}); });
  }

  /* ================= 行牌循环 ================= */

  /**
   * 摸牌并进入当前座位的行动。opts:
   *   noDraw   —— 吃/碰后不摸牌直接打
   *   fromTail —— 杠后从墙尾摸（岭上）
   */
  function nextTurn(opts) {
    if (G.phase !== 'playing') return;
    opts = opts || {};
    G.pendingTurn = false;   // 补发的行牌回合已落地，解除交互闸
    var p = P(G.turn);

    if (!opts.noDraw) {
      if (!G.wall.length) { settle(null, {}); return; }
      var tile = opts.fromTail ? G.wall.pop() : G.wall.shift();
      if (opts.fromTail) tile.lingshang = true;
      else p.draws++;               // 天胡/地胡判定用：只数自然摸牌（岭上不算）
      p.hand.push(tile);
      G.drawCount++;
      if (G.turn === 0) Sound.play('select');
    }
    G.busy = false;
    renderAll();
    renderHand();

    // 吃/碰后（noDraw）必须直接打牌，不允许自摸宣胡或再杠
    if (p.isAI) aiDrawAction(p, !!opts.noDraw);
    else humanDrawAction(!!opts.noDraw);
  }

  /* ---------- AI 行动 ---------- */

  function aiCtx(p) {
    var rivers = [];
    for (var i = 0; i < 4; i++) {
      if (i !== p.seat) rivers.push(P(i).river.map(function (t) { return t.idx; }));
    }
    var ctx = {
      difficulty: G.difficulty,
      seat: p.seat,
      counts: Tiles.countsOf(p.hand),
      meldBudget: meldBudget(p),
      unseen: unseenCounts(p.seat),
      opponentRivers: rivers,
      opponentTenpaiish: opponentTenpaiish(p.seat),
      wallLeft: G.wall.length
    };
    // 大师档是完全信息 AI（作弊难度，与斗地主大师同构）：
    // 直接看所有人手牌做精确推演，并按真实牌墙余量计算进张
    if (G.difficulty === 'master') {
      ctx.hands = G.players.map(function (q) { return q.hand; });
      ctx.meldCounts = G.players.map(function (q) { return q.melds.length; });
      ctx.wallUnseen = exactWallUnseen();
    }
    return ctx;
  }

  /** 真实牌墙组成（各家手牌+牌河+副露之外的部分），仅大师档使用 */
  function exactWallUnseen() {
    var u = new Array(34).fill(4);
    G.players.forEach(function (p) {
      p.hand.forEach(function (t) { u[t.idx]--; });
      p.river.forEach(function (t) { u[t.idx]--; });
      p.melds.forEach(function (m) { m.tiles.forEach(function (i) { u[i]--; }); });
    });
    return u;
  }

  function selfCheckCtx(p) {
    return {
      counts: Tiles.countsOf(p.hand),
      meldBudget: meldBudget(p),
      wallLeft: G.wall.length,
      difficulty: G.difficulty,
      pengMelds: p.melds.filter(function (m) { return m.type === 'peng'; })
        .map(function (m) { return m.tiles[0]; })
    };
  }

  function aiDrawAction(p, afterMeld) {
    var chk = afterMeld
      ? { win: false, gangIdx: -1, jiagangIdx: -1 }
      : AI.selfCheck(selfCheckCtx(p));

    if (chk.win) {
      G.thinkingSeat = p.seat;
      renderAll();
      later(700, function () {
        G.thinkingSeat = -1;
        doWin(p.seat, { selfDraw: true, tile: p.hand[p.hand.length - 1] });
      });
      return;
    }

    if (chk.gangIdx >= 0 && AI.shouldKong({
      difficulty: G.difficulty, wallLeft: G.wall.length
    })) {
      G.thinkingSeat = p.seat;
      renderAll();
      later(600, function () {
        G.thinkingSeat = -1;
        doAngang(p.seat, chk.gangIdx);
      });
      return;
    }

    if (chk.jiagangIdx >= 0 && AI.shouldKong({
      difficulty: G.difficulty, wallLeft: G.wall.length
    })) {
      G.thinkingSeat = p.seat;
      renderAll();
      later(600, function () {
        G.thinkingSeat = -1;
        doJiagang(p.seat, chk.jiagangIdx);
      });
      return;
    }

    G.busy = true;
    G.thinkingSeat = p.seat;
    renderAll();
    // AI 打牌决策与玩家打牌同环节，同样挂 30 秒倒计时环（AI 1~3 秒即出）
    MjUI.setTurnClock(p.seat, TURN_SECONDS);
    var cfg = AI.CFG[G.difficulty];
    var wait = cfg.thinkMs[0] + Math.random() * (cfg.thinkMs[1] - cfg.thinkMs[0]);
    later(wait, function () {
      G.thinkingSeat = -1;
      G.busy = false;
      var idx = AI.decideDiscard(aiCtx(p));
      var tile = pickTile(p, idx);
      doDiscard(p.seat, tile);
    });
  }

  function pickTile(p, idx) {
    for (var i = 0; i < p.hand.length; i++) {
      if (p.hand[i].idx === idx) return p.hand[i];
    }
    return p.hand[p.hand.length - 1];
  }

  /* ---------- 玩家行动 ---------- */

  function canDiscardNow() {
    return G.phase === 'playing' && G.turn === 0 && !G.busy && P(0).hand.length % 3 === 2;
  }

  function humanDrawAction(afterMeld) {
    var my = P(0);
    // 吃/碰后不做胡牌自查（没有摸牌就没有自摸），直接进入打牌
    var chk = afterMeld
      ? { win: false, gangIdx: -1, jiagangIdx: -1 }
      : AI.selfCheck(selfCheckCtx(my));
    // 自动胡：摸到即和，无需按键
    if (chk.win) {
      UI.toast('自动胡：' + Tiles.labelOf(my.hand[my.hand.length - 1].idx), 1600);
      doWin(0, { selfDraw: true, tile: my.hand[my.hand.length - 1] });
      return;
    }
    G.selected = null;
    renderHand();
    setActions({
      discard: false,
      hint: G.difficulty !== 'master',
      hu: chk.win,
      gang: chk.gangIdx >= 0 || chk.jiagangIdx >= 0
    });
    Sound.play('turn');
    startTimer();
    MjUI.setTurnClock(0, TURN_SECONDS);
  }

  function setActions(cfg) {
    MjUI.setActions({
      discard: cfg.discard,
      hint: cfg.hint,
      hu: cfg.hu,
      gang: cfg.gang
    });
  }

  /** 当前我方手牌的胡/杠自查（选中牌、按提示后刷新按钮时用） */
  function myCheck() {
    return AI.selfCheck(selfCheckCtx(P(0)));
  }

  /** 胡/杠按钮是否应点亮 */
  function gangable(chk) {
    return chk.gangIdx >= 0 || chk.jiagangIdx >= 0;
  }

  function onTileClick(tile) {
    if (!canDiscardNow()) return;
    if (G.selected && G.selected.id === tile.id) {
      // 再点一次选中的牌 = 直接打出
      var t = G.selected;
      G.selected = null;
      doDiscard(0, t);
      return;
    }
    G.selected = tile;
    Sound.play('select');
    renderHand();
    // 选牌不应关掉胡/杠机会（否则误触一张牌就错过自摸）
    var chk = myCheck();
    setActions({
      discard: true,
      hint: G.difficulty !== 'master',
      hu: chk.win,
      gang: gangable(chk)
    });
  }

  function doHint() {
    if (!canDiscardNow()) return;
    if (G.difficulty === 'master') { UI.toast('大师模式下提示已禁用'); return; }
    var cands = AI.hintCandidates(aiCtx(P(0)));
    if (!cands.length) return;
    G.hintIdx = ((G.hintIdx === undefined ? -1 : G.hintIdx) + 1) % cands.length;
    var idx = cands[G.hintIdx];
    var tile = pickTile(P(0), idx);
    G.selected = tile;
    renderHand();
    var chk = myCheck();
    setActions({
      discard: true,
      hint: true,
      hu: chk.win,
      gang: gangable(chk)
    });
    UI.toast('提示：打 ' + Tiles.labelOf(idx));
    Sound.play('select');
  }

  function tryDiscard() {
    if (!canDiscardNow()) return;
    if (!G.selected) { UI.toast('请先选一张牌'); return; }
    var t = G.selected;
    G.selected = null;
    // 注意：这里刻意不清计时器 —— 与「双击打牌」路径保持一致。
    // 计时器继续走完本回合预算，并驱动后续吃/碰/杠浮层的「超时自动过」；
    // 若在此清掉，按钮路径打出的牌会让争抢浮层失去超时（挂机即卡死）。
    doDiscard(0, t);
  }

  /* ---------- 打牌 ---------- */

  function doDiscard(seat, tile) {
    MjUI.clearTurnClock();
    var p = P(seat);
    p.hand = p.hand.filter(function (t) { return t.id !== tile.id; });
    delete tile.lingshang;
    p.river.push(tile);
    G.lastDiscard = { seat: seat, tile: tile };
    G.selected = null;
    Sound.play('play');
    if (seat === 0) renderHand();
    log(p.name + ' 打 ' + tile.label, seat === 0);
    if (typeof Voice !== 'undefined') Voice.speak(tile.label, Voice.seatGender(seat), 'vPlay');
    renderAll();

    var claims = buildClaims(seat, tile);
    if (claims.length) {
      G.busy = true;
      later(420, function () { resolveClaim(claims, seat); });
    } else {
      later(340, function () { G.turn = (seat + 1) % 4; nextTurn({}); });
    }
  }

  /* ---------- 副露 / 胡牌争抢 ---------- */

  function countIdx(p, idx) {
    var n = 0;
    p.hand.forEach(function (t) { if (t.idx === idx) n++; });
    return n;
  }

  function canWinOn(p, tile) {
    var c = Tiles.countsOf(p.hand);
    c[tile.idx]++;
    return Rules.isWin(c, meldBudget(p));
  }

  function chiRuns(p, idx) {
    var runs = [];
    if (idx >= 27) return runs;
    var suitBase = Math.floor(idx / 9) * 9;
    var off = idx - suitBase;
    var opts = [];
    if (off >= 2) opts.push([idx - 2, idx - 1, idx]);
    if (off >= 1 && off <= 7) opts.push([idx - 1, idx, idx + 1]);
    if (off <= 6) opts.push([idx, idx + 1, idx + 2]);
    opts.forEach(function (run) {
      var need = run.filter(function (i) { return i !== idx; });
      var ok = need.every(function (i) {
        return i >= suitBase && i < suitBase + 9 && countIdx(p, i) > 0;
      });
      if (ok) runs.push(run);
    });
    return runs;
  }

  /** 争抢队列：胡 > 杠 > 碰 > 吃，同级按离打牌者的下家顺序 */
  function buildClaims(fromSeat, tile) {
    var order = [(fromSeat + 1) % 4, (fromSeat + 2) % 4, (fromSeat + 3) % 4];
    var q = [];
    order.forEach(function (s) {
      if (canWinOn(P(s), tile)) q.push({ seat: s, type: 'hu' });
    });
    if (G.wall.length > 0) {
      order.forEach(function (s) {
        if (countIdx(P(s), tile.idx) === 3) q.push({ seat: s, type: 'gang' });
      });
    }
    order.forEach(function (s) {
      if (countIdx(P(s), tile.idx) >= 2) q.push({ seat: s, type: 'peng' });
    });
    // 吃：仅下家可吃
    var next = (fromSeat + 1) % 4;
    chiRuns(P(next), tile.idx).forEach(function (run) {
      q.push({ seat: next, type: 'chi', run: run });
    });
    return q;
  }

  function resolveClaim(queue, fromSeat) {
    if (G.phase !== 'playing') return;
    var claim = queue[0];
    if (!claim) {
      G.busy = false;
      G.turn = (fromSeat + 1) % 4;
      nextTurn({});
      return;
    }
    var p = P(claim.seat);
    var tile = G.lastDiscard.tile;

    if (p.isAI) {
      G.thinkingSeat = p.seat;
      renderAll();
      var cfg = AI.CFG[G.difficulty];
      var wait = cfg.thinkMs[0] * 0.5 + Math.random() * 300;
      later(wait, function () {
        G.thinkingSeat = -1;
        var yes;
        if (claim.type === 'hu') yes = AI.shouldWin();
        else if (claim.type === 'gang') yes = AI.shouldKong({ difficulty: G.difficulty, wallLeft: G.wall.length });
        else yes = AI.shouldClaimSet({
          difficulty: G.difficulty,
          counts: Tiles.countsOf(p.hand),
          meldBudget: meldBudget(p),
          unseen: unseenCounts(p.seat),
          opponentTenpaiish: false
        }, tile.idx, claim.type, claim.run);
        if (yes) applyClaim(claim, fromSeat);
        else {
          queue.shift();
          resolveClaim(queue, fromSeat);
        }
      });
      return;
    }

    // 玩家选择（胡牌自动胡，不再询问）
    if (claim.type === 'hu') {
      UI.toast('自动胡：接 ' + P(fromSeat).name + ' 的炮', 1600);
      applyClaim(claim, fromSeat);
      return;
    }
    G.busy = true;
    G.activeClaim = { queue: queue, fromSeat: fromSeat };
    // 争抢浮层给满完整的 30 秒（重置计时器），超时由 autoAct 自动「过」，
    // 不吃打出牌时剩下的零头预算
    startTimer();
    var label;
    if (claim.type === 'hu') label = '胡（' + Tiles.labelOf(tile.idx) + '）';
    else if (claim.type === 'gang') label = '杠（' + Tiles.labelOf(tile.idx) + '）';
    else if (claim.type === 'peng') label = '碰（' + Tiles.labelOf(tile.idx) + '）';
    else label = '吃 ' + claim.run.map(function (i) { return Tiles.shortOf(i); }).join('');

    UI.floatPanel(P(fromSeat).name + ' 打出 ' + Tiles.labelOf(tile.idx), [
      {
        text: label, cls: 'gold',
        onClick: function () {
          G.activeClaim = null;
          applyClaim(claim, fromSeat);
        }
      },
      {
        text: '过', cls: 'ghost',
        onClick: function () {
          G.activeClaim = null;
          G.busy = false;
          queue.shift();
          resolveClaim(queue, fromSeat);
        }
      }
    ], '这张牌要不要？');
  }

  function applyClaim(claim, fromSeat) {
    var p = P(claim.seat);
    var tile = G.lastDiscard.tile;
    var idx = tile.idx;

    if (claim.type === 'hu') {
      doWin(claim.seat, { selfDraw: false, tile: tile, loserSeat: fromSeat });
      return;
    }
    UI.closeFloat();
    takeFromRiver(fromSeat, tile);   // 打出的这张已被拿走，离开牌河
    // 从手中移除用掉的暗牌（打出的那张不在任何人手里）
    var usedIds = new Set();
    var need = (claim.type === 'gang') ? 3 : (claim.type === 'peng' ? 2 : 0);
    if (claim.type === 'chi') {
      claim.run.forEach(function (i) {
        if (i === idx) return;
        var t = takeTile(p, i);
        if (t) usedIds.add(t.id);
      });
    } else {
      for (var n = 0; n < need; n++) {
        var t2 = takeTile(p, idx);
        if (t2) usedIds.add(t2.id);
      }
    }
    p.hand = p.hand.filter(function (t) { return !usedIds.has(t.id); });

    var meldTiles = claim.type === 'chi' ? claim.run.slice() : [idx, idx, idx, idx].slice(0, claim.type === 'gang' ? 4 : 3);
    p.melds.push({ type: claim.type, tiles: meldTiles, from: fromSeat });

    Sound.play('double');
    var txt = claim.type === 'gang' ? '杠' : (claim.type === 'peng' ? '碰' : '吃');
    MjUI.bubble(claim.seat, txt + ' !', 'claim');
    if (typeof Voice !== 'undefined') Voice.speak(txt, Voice.seatGender(claim.seat), claim.type === 'gang' ? 'vGang' : 'vClaim');
    log(p.name + ' ' + txt + ' ' + Tiles.labelOf(idx), claim.seat === 0);

    G.busy = false;
    G.turn = claim.seat;
    G.pendingTurn = true;   // 420ms 后补发 noDraw/fromTail 回合，落地前禁止交互
    G.lastDiscard = null;
    renderAll();
    if (claim.seat === 0) renderHand();

    if (claim.type === 'gang') {
      later(420, function () { nextTurn({ fromTail: true }); });
    } else {
      later(420, function () { nextTurn({ noDraw: true }); });
    }
  }

  function takeTile(p, idx) {
    for (var i = 0; i < p.hand.length; i++) {
      if (p.hand[i].idx === idx) return p.hand.splice(i, 1)[0];
    }
    return null;
  }

  /** 把这张牌从某家牌河移除（被吃/碰/杠/点炮拿走时；不在河里则忽略，
   *  例如抢杠胡的牌来自宣杠者手牌）。不移除会让余牌器把同一张牌
   *  按「牌河 + 副露」双重扣减，显示与 AI 推算全部失真。 */
  function takeFromRiver(seat, tile) {
    var p = P(seat);
    if (!p) return;
    var i = p.river.indexOf(tile);
    if (i >= 0) p.river.splice(i, 1);
  }

  /** 暗杠：手里四张相同，杠后从墙尾补牌继续 */
  function doAngang(seat, idx) {
    var p = P(seat);
    var removed = [];
    p.hand = p.hand.filter(function (t) {
      if (t.idx === idx && removed.length < 4) { removed.push(t); return false; }
      return true;
    });
    p.melds.push({ type: 'angang', tiles: [idx, idx, idx, idx], from: seat });
    Sound.play('double');
    MjUI.bubble(seat, '暗杠 !', 'claim');
    if (typeof Voice !== 'undefined') Voice.speak('暗杠', Voice.seatGender(seat), 'vGang');
    log(p.name + ' 暗杠 ' + Tiles.labelOf(idx), seat === 0);
    renderAll();
    if (seat === 0) renderHand();
    G.pendingTurn = true;   // 补发岭上回合落地前禁止交互（与 applyClaim 同闸）
    later(500, function () {
      G.turn = seat;
      nextTurn({ fromTail: true });
    });
  }

  function tryGang() {
    if (!canDiscardNow()) return;
    var chk = myCheck();
    if (chk.gangIdx < 0 && chk.jiagangIdx < 0) { UI.toast('没有可以杠的牌'); return; }
    clearTimer();
    // 优先暗杠，其次加杠
    if (chk.gangIdx >= 0) doAngang(0, chk.gangIdx);
    else doJiagang(0, chk.jiagangIdx);
  }

  /**
   * 加杠：把手里已碰之牌的第 4 张补成杠。
   * 宣杠后其他家可以「抢杠胡」（用这张牌和牌），无人抢才真正成杠并岭上补牌。
   */
  function doJiagang(seat, idx) {
    var p = P(seat);
    var robbers = [];
    var order = [(seat + 1) % 4, (seat + 2) % 4, (seat + 3) % 4];
    order.forEach(function (s) {
      if (canWinOn(P(s), { idx: idx })) robbers.push(s);
    });
    if (robbers.length) { resolveRob(seat, idx, robbers); return; }
    applyJiagang(seat, idx);
  }

  /** 抢杠询问：AI 必胡；玩家弹浮层选择。全部放弃后加杠才生效 */
  function resolveRob(seat, idx, robbers) {
    if (G.phase !== 'playing') return;
    var claimer = robbers[0];
    var proceed = function (yes) {
      if (G.phase !== 'playing') return;
      if (yes) {
        var tile = takeTile(P(seat), idx);
        tile.qianggang = true;
        doWin(claimer, { selfDraw: false, tile: tile, loserSeat: seat });
        return;
      }
      robbers.shift();
      if (robbers.length) { resolveRob(seat, idx, robbers); return; }
      applyJiagang(seat, idx);
    };

    if (P(claimer).isAI) {
      G.thinkingSeat = claimer;
      renderAll();
      later(500, function () {
        G.thinkingSeat = -1;
        proceed(AI.shouldWin());
      });
      return;
    }
    // 玩家自动抢杠胡
    UI.toast('自动胡：抢 ' + P(seat).name + ' 的杠', 1600);
    proceed(true);
  }

  /** 加杠真正生效：升级碰为杠，岭上补牌 */
  function applyJiagang(seat, idx) {
    var p = P(seat);
    var tile = takeTile(p, idx);
    if (!tile) return;
    for (var i = 0; i < p.melds.length; i++) {
      var m = p.melds[i];
      if (m.type === 'peng' && m.tiles[0] === idx) {
        m.type = 'gang';
        m.tiles.push(idx);
        break;
      }
    }
    Sound.play('double');
    MjUI.bubble(seat, '加杠 !', 'claim');
    if (typeof Voice !== 'undefined') Voice.speak('加杠', Voice.seatGender(seat), 'vGang');
    log(p.name + ' 加杠 ' + Tiles.labelOf(idx), seat === 0);
    renderAll();
    if (seat === 0) renderHand();
    G.pendingTurn = true;   // 补发岭上回合落地前禁止交互（与 applyClaim 同闸）
    later(500, function () {
      G.turn = seat;
      nextTurn({ fromTail: true });
    });
  }

  function tryHu() {
    if (!canDiscardNow()) return;
    var counts = Tiles.countsOf(P(0).hand);
    if (!Rules.isWin(counts, meldBudget(P(0)))) { UI.toast('还没有胡牌'); return; }
    clearTimer();
    var last = P(0).hand[P(0).hand.length - 1];
    doWin(0, { selfDraw: true, tile: last });
  }

  /* ================= 胡牌结算 ================= */

  /** 局终亮牌：对手（1-3 家，含胡牌者）手牌的牌面 HTML；对局过程中从不展示 */
  function revealHandsHtml(winnerSeat) {
    return G.players.map(function (p) {
      if (p.seat === 0) return '';   // 我的手牌一直可见
      var tag = (p.seat === winnerSeat) ? '（胡）' : '';
      var face = p.hand.length
        ? MjUI.tilesHtml(p.hand.map(function (t) { return t.idx; }))
        : '—';
      return '<div class="kv reveal-kv"><span>' + p.name + tag + '</span>' +
        '<b class="reveal-hand">' + face + '</b></div>';
    }).join('');
  }

  function doWin(winnerSeat, opts) {
    MjUI.clearTurnClock();
    UI.closeFloat();
    var w = P(winnerSeat);
    if (!opts.selfDraw) {
      w.hand.push(opts.tile);   // 点炮的牌并入手牌展示
      // 同一张牌离开点炮者牌河，否则余牌器按「牌河+手牌」双重扣减
      //（抢杠时这张牌来自宣杠者手牌，不在河里，按身份匹配自动跳过）
      takeFromRiver(opts.loserSeat, opts.tile);
    }
    G.phase = 'over';
    clearTimer();
    G.thinkingSeat = -1;
    G.busy = false;

    var counts = Tiles.countsOf(w.hand);
    var winTile = opts.tile;
    // 天胡/地胡：第一巡自然摸牌即胡。岭上补牌不算（有 lingshang 标记）；
    // 抢杠/点炮的牌不来自本巡摸牌（selfDraw 为 false，天然不触发）；
    // 有副露说明第一巡之前已有行牌，按惯例也不成立。
    if (opts.selfDraw && winTile && !winTile.lingshang &&
      P(winnerSeat).draws === 1 && w.melds.length === 0) {
      winTile[winnerSeat === G.dealer ? 'tianhu' : 'dihu'] = true;
    }
    // winTile 携带 lingshang / qianggang 等标志，直接交给番种评定
    var score = Rules.scoreHands(counts, w.melds, winTile || {}, opts.selfDraw);
    var unit = 100 * score.fan;

    // 计分：自摸三家各付；点炮由点炮者一家付。庄家参与结算时翻倍。
    G.players.forEach(function (p) { p.delta = 0; });
    if (opts.selfDraw) {
      for (var s = 0; s < 4; s++) {
        if (s === winnerSeat) continue;
        var amt = unit * (isDealer(s) ? 2 : 1) * (isDealer(winnerSeat) ? 2 : 1);
        P(s).delta -= amt;
        w.delta += amt;
      }
    } else {
      var amt2 = unit * (isDealer(opts.loserSeat) ? 2 : 1) * (isDealer(winnerSeat) ? 2 : 1);
      P(opts.loserSeat).delta -= amt2;
      w.delta += amt2;
    }

    var iWin = (winnerSeat === 0);
    var myDelta = P(0).delta;
    if (winnerSeat !== null) {
      Store.recordGame({ role: 'mahjong', win: iWin, delta: myDelta }, 'mj');
    }
    Sound.play(iWin ? 'win' : 'lose');
    if (typeof Voice !== 'undefined') Voice.speak(iWin ? '我胡了' : w.name + '胡了', Voice.seatGender(winnerSeat), 'vHu');
    MjUI.bubble(winnerSeat, '胡 !', 'win');
    log('—— ' + w.name + ' 胡 ' + Tiles.labelOf(winTile.idx) + '（' + score.fan + ' 番）——', true);

    var scoreRows = G.players.map(function (p) {
      return '<div class="kv"><span>' + p.name + (isDealer(p.seat) ? '（庄）' : '') +
        '</span><b class="' + (p.delta >= 0 ? 'plus' : 'minus') + '">' +
        (p.delta > 0 ? '+' : '') + p.delta + '</b></div>';
    }).join('');

    var detailRows =
      '<div class="kv"><span>胡牌者</span><b>' + w.name + '</b></div>' +
      '<div class="kv"><span>方式</span><b>' + (opts.selfDraw ? '自摸' :
        (winTile && winTile.qianggang ? ('抢 ' + P(opts.loserSeat).name + ' 的杠')
          : ('接 ' + P(opts.loserSeat).name + ' 的炮'))) + '</b></div>' +
      '<div class="kv"><span>番种</span><b>' + score.names.join(' · ') + '</b></div>' +
      '<div class="kv"><span>番数</span><b>' + score.fan + ' 番（' + unit + ' 分）</b></div>';

    // 局终亮牌：展示对手（含胡牌者）的手牌（对局过程中不显示）。
    // 可折叠：桌面默认展开，手机横屏默认收起（保证结算面板免拖动）
    var revealOpen = document.body.classList.contains('is-mobile') ? '' : ' open';
    var revealRows = revealHandsHtml(winnerSeat);

    /* 结算面板：加宽双栏（明细 | 各家得失），亮牌可折叠；删累计战绩（📊 可查看）；
     * 「复盘牌桌」隐藏面板回看牌桌终态（UI.showRecall 呼出） */
    G.settleHtml =
      '<div class="settle-title ' + (iWin ? 'win' : 'lose') + '">' +
      (iWin ? '我胡了！' : w.name + ' 胡') + '</div>' +
      '<div class="settle-grid">' +
      '<div class="sec"><h4>本局明细</h4>' + detailRows + '</div>' +
      '<div class="sec"><h4>各家得失</h4>' + scoreRows + '</div>' +
      (revealRows ? '<details class="reveal-box"' + revealOpen + '><summary>亮牌 · 各家手牌</summary>' + revealRows + '</details>' : '') +
      '</div>';
    showSettle();
    renderAll();
  }

  /** 结算面板展示（首见与「复盘呼出」共用；内容取自 G.settleHtml 快照，不重复计分） */
  function showSettle() {
    if (!G.settleHtml) return;
    UI.showDialog(G.settleHtml, [
      { text: '再来一局', cls: 'gold', onClick: function () { UI.hideRecall(); newGame(); } },
      {
        text: '复盘牌桌', cls: 'ghost', silent: true,
        onClick: function () {
          UI.showRecall(MjUI.el('mjTable'), '查看结算', showSettle);
        }
      },
      { text: '换个场次', cls: 'ghost', onClick: function () { UI.hideRecall(); enterLobby(); } }
    ], 'wide');
  }

  /** 荒庄：牌墙摸完无人胡牌 */
  function settleNull() {
    G.phase = 'over';
    clearTimer();
    G.thinkingSeat = -1;
    G.busy = false;
    Sound.play('pass');
    log('—— 牌墙已尽，荒庄 ——', true);

    var revealOpen2 = document.body.classList.contains('is-mobile') ? '' : ' open';
    G.settleHtml =
      '<div class="settle-title lose">荒 庄</div>' +
      '<div class="settle-grid">' +
      '<div class="sec"><h4>本局明细</h4>' +
      '<div class="kv"><span>结果</span><b>牌墙摸完，无人胡牌</b></div>' +
      '<div class="kv"><span>计分</span><b>荒庄不计分</b></div>' +
      '</div>' +
      '<details class="reveal-box"' + revealOpen2 + '><summary>亮牌 · 各家手牌</summary>' + revealHandsHtml(-1) + '</details>' +
      '</div>';
    showSettle();
    renderAll();
  }

  function settle(arg, opts) {
    if (arg === null) { settleNull(); return; }
    doWin(arg, opts || {});
  }

  /* ================= 弹窗内容 ================= */

  function showStats() {
    var s = Store.getStats('mj');
    UI.showDialog(
      '<h2>战 绩 统 计</h2>' +
      '<div class="sec"><h4>麻将</h4>' +
      '<div class="kv"><span>总场次</span><b>' + s.games + ' 局</b></div>' +
      '<div class="kv"><span>总胜率</span><b>' + (Store.winRate('mj') * 100).toFixed(1) + '%</b></div>' +
      '<div class="kv"><span>累计积分</span><b>' + s.score + '</b></div>' +
      '<div class="kv"><span>当前连胜</span><b>' + s.streak + '</b></div>' +
      '<div class="kv"><span>最高连胜</span><b>' + s.bestStreak + '</b></div>' +
      '<div class="kv"><span>存储方式</span><b>' + (Store.persistent ? '本地持久化' : '临时内存') + '</b></div>' +
      '</div>',
      [
        { text: '清空战绩', cls: 'ghost', onClick: function () { Store.resetStats('mj'); UI.toast('战绩已清空'); } },
        { text: '关闭', cls: 'gold' }
      ]
    );
  }

  function showHelp() {
    UI.showDialog(
      '<h2>麻 将 规 则</h2>' +
      '<div class="sec"><h4>行牌</h4>' +
      '<p>136 张牌（万/条/筒 1-9 与 东南西北中发白 各 4 张），四人游戏。</p>' +
      '<p>每家 13 张起手，庄家先摸；摸牌 → 打牌循环，逆时针行牌。</p>' +
      '<p>别家打牌时你可以 <b>胡 / 杠 / 碰</b>，下家还可以 <b>吃</b>（优先级 胡 &gt; 杠 &gt; 碰 &gt; 吃）。</p>' +
      '<p>手中有四张相同的牌可<b>暗杠</b>；已碰之牌摸到第 4 张可<b>加杠</b>。' +
      '加杠宣言时，其他家若正等这张牌可<b>抢杠胡</b>。杠后均从墙尾补牌。</p>' +
      '</div>' +
      '<div class="sec"><h4>胡牌</h4>' +
      '<p>四组面子（顺子/刻子）+ 一对雀头；门清时七对、国士无双也可胡。</p>' +
      '</div>' +
      '<div class="sec"><h4>番种与计分</h4>' +
      '<p>平胡 1 番起，累加：自摸 +1、门前清 +1、杠上开花 +1、抢杠胡 +1、' +
      '碰碰胡 +2、混一色 +2、七对 +3、清一色 +4、字一色 +6、地胡 +3、天胡 +6、国士无双 +13。</p>' +
      '<p>得分 = 底分（100）× 总番数；自摸三家各付，点炮由点炮者付；庄家参与结算时翻倍。</p>' +
      '</div>' +
      '<div class="sec"><h4>操作</h4>' +
      '<p>点击手牌选中，再点一次直接打出；或选中后按「打出」。</p>' +
      '<p>「提示」按高手思路推荐打牌（大师模式隐藏）。</p>' +
      '<p>回合倒计时 ' + TURN_SECONDS + ' 秒，超时自动打推荐牌 / 自动过。</p>' +
      '<p><b>自动胡</b>：自摸 / 接炮 / 抢杠能胡时自动和牌，无需按键。</p>' +
      '</div>',
      [{ text: '知道了', cls: 'gold' }]
    );
  }

  /* ================= 计时 ================= */

  function startTimer() {
    clearTimer();
    var gen = G.gen;
    G.timeLeft = TURN_SECONDS;
    G.timer = setInterval(function () {
      if (G.gen !== gen || G.phase !== 'playing') { clearTimer(); return; }
      // 打出牌后计时器继续跑（驱动争抢浮层超时），但轮到 AI 行牌且
      // 没有等我的争抢浮层时，它已无事可做 → 停掉（否则会在 AI 回合
      // 白响「最后 5 秒」警告音）
      if (G.turn !== 0 && !G.activeClaim) { clearTimer(); return; }
      if (UI.overlayShown()) return;   // 帮助/战绩等弹窗打开时暂停倒计时
      G.timeLeft--;
      if (G.timeLeft <= 0) { clearTimer(); autoAct(); return; }
      if (G.timeLeft <= 5 && G.turn === 0) Sound.play('warn');
      MjUI.tickTurnClock(G.timeLeft);
    }, 1000);
  }

  function clearTimer() {
    if (G.timer) { clearInterval(G.timer); G.timer = null; }
    G.timeLeft = 0;
  }

  function autoAct() {
    if (G.phase !== 'playing') return;
    if (G.busy) {
      // 争抢浮层挂起 → 视为过，继续处理后续争抢
      if (G.activeClaim) {
        var ac = G.activeClaim;
        G.activeClaim = null;
        G.busy = false;
        UI.closeFloat();
        UI.toast('超时，自动过');
        if (ac.jiagang) ac.pass();          // 放弃抢杠 → 继续加杠流程
        else { ac.queue.shift(); resolveClaim(ac.queue, ac.fromSeat); }
      }
      return;
    }
    if (!canDiscardNow()) return;
    UI.toast('超时，自动出牌');
    var cands = AI.hintCandidates(aiCtx(P(0)));
    var tile = cands.length ? pickTile(P(0), cands[0]) : P(0).hand[P(0).hand.length - 1];
    doDiscard(0, tile);
  }

  /* ================= 初始化 ================= */

  function init() {
    MjUI.bindDom();
    MjUI.setTileClickHandler(onTileClick);

    var prefs = Store.getPrefs();
    G.difficulty = prefs.mjDifficulty || 'hard';

    MjUI.el('mjBtnDiscard').addEventListener('click', tryDiscard);
    MjUI.el('mjBtnHint').addEventListener('click', doHint);
    MjUI.el('mjBtnHu').addEventListener('click', tryHu);
    MjUI.el('mjBtnGang').addEventListener('click', tryGang);

    var roomBtns = MjUI.el('mjLobby').querySelectorAll('button');
    for (var i = 0; i < roomBtns.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var d = btn.dataset.d;
          if (!d || G.phase !== 'lobby') return;
          G.difficulty = d;
          Store.setPrefs({ mjDifficulty: d });
          MjUI.setHintVisible(d !== 'master');
          MjUI.hideLobby();
          newGame();
        });
      })(roomBtns[i]);
    }

    // 对局结束后关掉所有弹窗 → 回到麻将选场大厅（仅当当前游戏是麻将）
    UI.addDialogCloseHandler(function () {
      if (global.App && global.App.current !== 'mj') return;
      if (G.phase === 'over') enterLobby();
    });

    MjUI.setHintVisible(G.difficulty !== 'master');
    // 初始不再自动开局 —— 由 App 的游戏模式大厅接管
    highlightRoomsLater();
  }

  function highlightRoomsLater() {
    MjUI.highlightRooms(G.difficulty);
  }

  global.MjGame = {
    G: G,
    enterLobby: enterLobby,
    newGame: newGame,
    suspend: suspend,
    showStats: showStats,
    showHelp: showHelp,
    /* 仅供测试驱动内部流程（真实路径触发），不承担对外语义 */
    __hooks: { nextTurn: nextTurn, humanDrawAction: humanDrawAction }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})(typeof window !== 'undefined' ? window : globalThis);
