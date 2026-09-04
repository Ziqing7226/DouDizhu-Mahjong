/* 斗地主 —— 纯前端单机斗地主游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * game.js —— 游戏主流程（发牌 → 叫分抢地主 → 加倍 → 出牌 → 结算）
 * 座位约定：0 = 玩家（下方），1 = 右侧 AI，2 = 左侧 AI
 * 出牌顺序：0 → 1 → 2 → 0
 * ========================================================================== */
(function (global) {
  'use strict';

  var Cards = global.Cards;
  var Dec = global.Decompose;
  var AI = global.AI;
  var UI = global.UI;
  var Sound = global.Sound;
  var Store = global.Store;
  var Bgm = global.Bgm;
  var CT = Cards.CT;

  var TURN_SECONDS = 30;   // 玩家回合倒计时

  var G = {
    phase: 'lobby',       // lobby | bidding | doubling | playing | over
    gen: 0,               // 局次令牌：每开新局 +1，用于丢弃上一局的遗留回调
    players: [],
    bottom: [],
    landlord: -1,
    turn: 0,
    lastCombo: null,
    lastSeat: -1,
    passCount: 0,
    played: [],
    multiplier: 1,
    baseScore: 100,
    bombs: 0,
    bid: { max: 0, maxSeat: -1, order: [], idx: 0 },
    doubleQueue: [],
    landlordPlays: 0,
    farmerPlays: 0,
    logs: [],
    selected: [],
    hints: [],
    hintIdx: 0,
    difficulty: 'hard',
    nextOpponents: null,  // 下一次开局使用的对手（进入大厅时刷新；「再来一局」保持不变）
    busy: false,
    timer: null,
    timeLeft: 0
  };

  /* ================= 对手网名 ================= */

  /* AI 对手的随机网名池：形容词 + 名词组合，头像从表情池抽取。
   * 每次回到选场大厅都会重新抽取，营造「换个桌子换了批牌友」的感觉；
   * 「再来一局」不经过大厅，因此还是原来那两位。 */
  var NAME_HEADS = ['快乐的', '犯困的', '摸鱼的', '无敌的', '低调的', '吃瓜的', '追风的',
    '熬夜的', '种花的', '打铁的', '看海的', '会飞的', '爱笑的', '营业中的',
    '深藏不露的', '刚睡醒的', '热衷背锅的', '只想赢的', '燃烧卡路里的', '不露声色的'];
  var NAME_TAILS = ['小鱼干', '土豆侠', '猫头鹰', '河豚', '松鼠', '老王', '柯基',
    '外卖员', '钢琴师', '码头工', '冰淇淋', '打工人', '小钢炮', '扫地僧',
    '西瓜太郎', '夜猫子', '牛奶糖', '老司机', '小诸葛', '钓鱼佬'];
  var OPP_AVATARS = ['🐯', '🐼', '🐸', '🦊', '🐻', '🐨', '🦁', '🐵', '🐰', '🐷',
    '🐮', '🐺', '🦉', '🐙', '🦖', '🐳'];

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
    G.nextOpponents = [a, b];
    return G.nextOpponents;
  }

  /* ================= 工具 ================= */

  function P(seat) { return G.players[seat]; }

  /**
   * 带「局次令牌」的延时调用：一旦开了新局，上一局遗留的回调会被直接丢弃。
   * 否则在 AI 思考 / 动画播放途中重开一局时，旧回调会污染新对局的状态。
   *
   * 同时登记进待执行队列，由 800ms 心跳兜底：移动端浏览器把页面切到
   * 后台时会冻结/丢弃 setTimeout，回到前台后若定时器已丢，心跳会把
   * 超期任务立即补跑 —— 修复「高手场 AI 一直不出牌」（后台回来游戏卡死）。
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
  function roleOf(seat) { return seat === G.landlord ? 'landlord' : 'farmer'; }
  function teammateOf(seat) {
    if (seat === G.landlord) return -1;
    for (var i = 0; i < 3; i++) if (i !== seat && i !== G.landlord) return i;
    return -1;
  }
  function counts() { return G.players.map(function (p) { return p.hand.length; }); }

  function log(text, me) {
    G.logs.push({ text: text, me: !!me });
    UI.renderLogs(G.logs);
  }

  function refreshCounter() {
    UI.renderCounter(G.played, P(0).hand);
  }

  function updateInfo() {
    var me = P(0);
    // 三家手牌合计：叫分阶段为 51（底牌未揭开），地主拿底后随出牌递减。
    // 旧公式 54 − 已出 − 底牌3 在拿底后恒少 3（底牌已进手牌却仍被扣减）
    var handTotal = 0;
    for (var h = 0; h < G.players.length; h++) handTotal += G.players[h].hand.length;
    UI.renderInfo([
      ['难度', AI.CFG[G.difficulty].name],
      ['我的身份', me.role === 'landlord' ? '地主' : (me.role === 'farmer' ? '农民' : '待定')],
      ['底分', G.baseScore],
      ['当前倍数', '×' + G.multiplier],
      ['已出炸弹', G.bombs + ' 个'],
      ['牌桌剩余', handTotal + ' 张']
    ]);
  }

  function renderAll() {
    var st = {
      activeSeat: (G.phase === 'playing') ? G.turn : -1,
      thinkingSeat: G.thinkingSeat
    };
    for (var s = 0; s < 3; s++) UI.renderBox(s, P(s), st);
    UI.renderMultiplier(G.baseScore, G.multiplier);
    updateInfo();
  }

  /* ================= 开局 ================= */

  /* ---------- 发牌调控：按难度给玩家「软性」偏向好牌 ----------
   * 「好牌」评分定义（越大越好）：
   *   控制力 —— 王炸 +8、单王 +3 / +3.5、每个 2 +2、每个 A +1、普通炸弹 +5
   *   结构   —— 最优拆解手数越少越顺，每手 −1.2（17 张纯随机约 7~10 手）
   * 手段：随机发 N 副，取玩家 17 张评分最高的一副（best-of-N）。
   *   新手 N≈6：好牌明显偏多；高手 N≈3：略偏；大师 N=1：纯随机。
   * 隐蔽性：best-of 只抬高期望、不构造固定牌型，且 N 带随机抖动，
   * 手牌外观每局仍完全多样，玩家不会感到「每局牌都相似」。
   */
  function handStrength(hand) {
    var cnt = {};
    for (var i = 0; i < hand.length; i++) {
      var r = hand[i].rank;
      cnt[r] = (cnt[r] || 0) + 1;
    }
    var score = 0;
    if (cnt[16]) score += 3;
    if (cnt[17]) score += 3.5;
    if (cnt[16] && cnt[17]) score += 4;
    score += (cnt[15] || 0) * 2;
    score += (cnt[14] || 0) * 1;
    for (var k in cnt) if (cnt[k] === 4 && +k <= 15) score += 5;
    score -= Dec.minHands(hand, 'quick') * 1.2;
    return score;
  }

  function riggedDeck(difficulty) {
    var n = difficulty === 'easy' ? 5 + ((Math.random() * 3) | 0)
          : difficulty === 'hard' ? 2 + ((Math.random() * 2) | 0)
          : 1;
    if (n <= 1) return Cards.shuffle(Cards.makeDeck());
    var best = null, bestScore = -1e9;
    for (var t = 0; t < n; t++) {
      var deck = Cards.shuffle(Cards.makeDeck());
      var s = handStrength(deck.slice(0, 17));
      if (s > bestScore) { bestScore = s; best = deck; }
    }
    return best;
  }

  function newGame() {
    // 温馨提醒闸门：连续游玩超半小时 → 先弹休息提醒，确认后再开局
    if (global.Health && global.Health.gate(function () { newGame(); })) return;
    G.gen++;              // 作废旧局所有未执行的回调
    clearTimer();
    UI.clearTurnClock();
    UI.hideRecall();
    G.settleHtml = null;
    Dec.resetCache();
    UI.closeFloat();
    UI.closeDialog();
    UI.clearAllSlots();
    UI.hideLobby();

    var deck = riggedDeck(G.difficulty);
    var opp = G.nextOpponents || rollOpponents();
    G.players = [
      { seat: 0, name: '我', avatar: '🙂', isAI: false, hand: Cards.sortCards(deck.slice(0, 17)), role: null, bid: 0, doubled: 0 },
      { seat: 1, name: opp[0].name, avatar: opp[0].avatar, isAI: true, hand: Cards.sortCards(deck.slice(17, 34)), role: null, bid: 0, doubled: 0 },
      { seat: 2, name: opp[1].name, avatar: opp[1].avatar, isAI: true, hand: Cards.sortCards(deck.slice(34, 51)), role: null, bid: 0, doubled: 0 }
    ];
    G.bottom = deck.slice(51, 54);
    G.landlord = -1;
    G.turn = 0;
    G.thinkingSeat = -1;
    G.lastCombo = null;
    G.lastSeat = -1;
    G.passCount = 0;
    G.played = [];
    G.multiplier = 1;
    G.bombs = 0;
    G.bid = { max: 0, maxSeat: -1, order: [], idx: 0 };
    G.doubleQueue = [];
    G.landlordPlays = 0;
    G.farmerPlays = 0;
    G.logs = [];
    G.selected = [];
    G.hints = [];
    G.hintIdx = 0;
    G.busy = false;
    G.phase = 'bidding';

    UI.renderBottom(G.bottom, false);
    UI.clearAllSlots();
    UI.setActions({ play: false, pass: false, hint: false, clear: false });
    UI.setHintVisible(hintEnabled());   // 大师档整局隐藏提示按钮
    renderHand();
    UI.dealAnimation(P(0).hand);
    Sound.play('deal');
    refreshCounter();
    log('—— 新的一局开始 ——');
    renderAll();

    later(900, startBidding);
  }

  function renderHand() {
    UI.renderHand(P(0).hand, G.selected, G.phase === 'playing' && G.turn === 0 && !G.busy);
  }

  /* ================= 叫分抢地主 ================= */

  function startBidding() {
    var first = (Math.random() * 3) | 0;
    G.bid = { max: 0, maxSeat: -1, order: [first, (first + 1) % 3, (first + 2) % 3], idx: 0 };
    log('由 ' + P(first).name + ' 开始叫分');
    askBid();
  }

  function askBid() {
    if (G.bid.idx >= 3) { finishBidding(); return; }
    var seat = G.bid.order[G.bid.idx];
    G.turn = seat;
    renderAll();

    if (P(seat).isAI) {
      G.busy = true;
      G.thinkingSeat = seat;
      renderAll();
      var cfg = AI.CFG[G.difficulty];
      var wait = cfg.thinkMs[0] + Math.random() * (cfg.thinkMs[1] - cfg.thinkMs[0]);
      later(wait, function () {
        G.thinkingSeat = -1;
        var v = AI.decideBid(P(seat).hand, { difficulty: G.difficulty, maxBidSoFar: G.bid.max });
        G.busy = false;
        applyBid(seat, Math.min(3, Math.max(0, v)));
      });
      return;
    }

    // 玩家叫分
    var s = AI.bidScore(P(0).hand);
    var advice = s >= 13 ? '手牌很强，建议叫 3 分' :
      s >= 9.5 ? '手牌不错，可以考虑 2 分' :
        s >= 6.5 ? '手牌一般，1 分试试' : '手牌偏弱，建议不叫';

    UI.floatPanel('叫 分 抢 地 主', [
      { text: '不叫', cls: 'ghost', onClick: function () { applyBid(0, 0); } },
      {
        text: '1 分', cls: 'gold', disabled: G.bid.max >= 1,
        onClick: function () { applyBid(0, 1); }
      },
      {
        text: '2 分', cls: 'gold', disabled: G.bid.max >= 2,
        onClick: function () { applyBid(0, 2); }
      },
      {
        text: '3 分', cls: 'gold', disabled: G.bid.max >= 3,
        onClick: function () { applyBid(0, 3); }
      }
    ], advice + '（当前最高 ' + G.bid.max + ' 分）');
  }

  function applyBid(seat, score) {
    P(seat).bid = score;
    if (score > G.bid.max) { G.bid.max = score; G.bid.maxSeat = seat; }
    log(P(seat).name + (score ? '叫了 ' + score + ' 分' : '不叫'), seat === 0);
    Sound.play('bid', score);
    if (typeof Voice !== 'undefined') Voice.announceBid(seat, score);
    UI.toast(P(seat).name + (score ? '叫 ' + score + ' 分' : '不叫'), 1100);
    renderAll();

    if (score === 3) { finishBidding(); return; }
    G.bid.idx++;
    if (G.bid.idx >= 3) finishBidding();
    else later(260, askBid);
  }

  function finishBidding() {
    if (G.bid.max === 0) {
      UI.toast('三家都不叫，重新发牌');
      log('三家都不叫，重新发牌');
      later(1400, newGame);
      return;
    }
    var L = G.bid.maxSeat;
    G.landlord = L;
    for (var s = 0; s < 3; s++) P(s).role = roleOf(s);
    P(L).hand = Cards.sortCards(P(L).hand.concat(G.bottom));
    G.multiplier = G.bid.max;

    UI.renderBottom(G.bottom, true);
    UI.toast(P(L).name + ' 以 ' + G.bid.max + ' 分成为地主！', 1600);
    log(P(L).name + ' 成为地主（' + G.bid.max + ' 分，底分倍数 ×' + G.bid.max + '）', L === 0);
    Sound.play('double');
    if (typeof Voice !== 'undefined') Voice.announceLandlord(L);
    renderAll();
    if (L === 0) renderHand();

    later(900, startDoubling);
  }

  /* ================= 加倍 ================= */

  function startDoubling() {
    G.phase = 'doubling';
    G.doubleQueue = [];
    for (var s = 0; s < 3; s++) if (s !== G.landlord) G.doubleQueue.push(s);
    G.doubleQueue.push(G.landlord);   // 地主最后决定
    askDouble();
  }

  function askDouble() {
    if (!G.doubleQueue.length) { startPlaying(); return; }
    var seat = G.doubleQueue.shift();
    G.turn = seat;
    renderAll();

    if (P(seat).isAI) {
      G.busy = true;
      G.thinkingSeat = seat;
      renderAll();
      var cfg = AI.CFG[G.difficulty];
      var wait = cfg.thinkMs[0] * 0.6 + Math.random() * 300;
      later(wait, function () {
        G.thinkingSeat = -1;
        var farmerDoubled = 0;
        for (var i = 0; i < 3; i++) if (i !== G.landlord) farmerDoubled += (P(i).doubled || 0);
        var v = AI.decideDouble(P(seat).hand, {
          difficulty: G.difficulty, role: roleOf(seat), farmerDoubled: farmerDoubled
        });
        G.busy = false;
        applyDouble(seat, v);
      });
      return;
    }

    var isLandlord = (seat === G.landlord);
    var btns = [{ text: '不加倍', cls: 'ghost', onClick: function () { applyDouble(0, 0); } }];
    var farmerDoubled = 0;
    for (var i = 0; i < 3; i++) if (i !== G.landlord) farmerDoubled += (P(i).doubled || 0);
    btns.push({
      text: '加倍 ×2', cls: 'gold',
      onClick: function () { applyDouble(0, 1); }
    });
    if (!isLandlord) {
      btns.push({
        text: '超级加倍 ×4', cls: 'gold',
        onClick: function () { applyDouble(0, 2); }
      });
    }
    UI.floatPanel(isLandlord ? '是 否 加 倍' : '农 民 加 倍',
      btns,
      isLandlord
        ? ('农民已加倍 ' + farmerDoubled + ' 次，你可选择是否反加')
        : '牌好就加倍，赢的积分翻倍！');
  }

  function applyDouble(seat, level) {
    P(seat).doubled = level;
    if (level === 1) { G.multiplier *= 2; Sound.play('double'); }
    else if (level === 2) { G.multiplier *= 4; Sound.play('double'); }
    var txt = level === 1 ? '加倍' : (level === 2 ? '超级加倍' : '不加倍');
    log(P(seat).name + ' ' + txt, seat === 0);
    if (typeof Voice !== 'undefined') Voice.announceDouble(seat, level);
    if (level) UI.toast(P(seat).name + txt + '！倍数 ×' + G.multiplier, 1300);
    renderAll();
    later(320, askDouble);
  }

  /* ================= 出牌 ================= */

  function startPlaying() {
    G.phase = 'playing';
    G.turn = G.landlord;
    G.lastCombo = null;
    G.lastSeat = -1;
    G.passCount = 0;
    G.selected = [];
    G.hints = [];
    G.hintIdx = 0;
    UI.clearAllSlots();
    renderHand();
    renderAll();
    updateMood();
    log('出牌阶段开始，' + P(G.landlord).name + ' 先出');
    later(320, nextTurn);
  }

  function nextTurn() {
    if (G.phase !== 'playing') return;

    // 两家都不要 → 上一手牌的打出者重新领出
    if (G.lastCombo && G.lastSeat === G.turn) {
      G.lastCombo = null;
      G.passCount = 0;
      UI.clearAllSlots();
      log(P(G.turn).name + ' 重新出牌');
    }

    var p = P(G.turn);
    if (!p.hand.length) { return; }
    renderAll();
    // 行动方头像挂 30 秒倒计时环（AI 与玩家同款；AI 1~3 秒即出，环提前消失）
    UI.setTurnClock(G.turn, TURN_SECONDS);

    if (p.isAI) aiTurn(G.turn);
    else humanTurn();
  }

  /* ---------- AI 回合 ---------- */

  function aiTurn(seat) {
    G.busy = true;
    G.thinkingSeat = seat;
    renderAll();

    var cfg = AI.CFG[G.difficulty];
    var wait = cfg.thinkMs[0] + Math.random() * (cfg.thinkMs[1] - cfg.thinkMs[0]);

    later(wait, function () {
      var p = P(seat);
      var ctx = {
        difficulty: G.difficulty,
        hand: p.hand,
        seat: seat,
        role: roleOf(seat),
        landlordSeat: G.landlord,
        teammateSeat: teammateOf(seat),
        lastCombo: G.lastCombo,
        lastSeat: G.lastSeat,
        counts: counts(),
        played: G.played,
        // 大师档是完全信息 AI（作弊难度）：把真实手牌交给它做精确推演
        hands: G.difficulty === 'master' ? G.players.map(function (p) { return p.hand; }) : null
      };
      var res = null;
      try {
        res = AI.decidePlay(ctx);
      } catch (e) {
        // 决策异常时退化为「不要」，保证对局不会卡死
        console.error('AI 决策异常', e);
        res = null;
      }
      G.thinkingSeat = -1;
      G.busy = false;
      if (res && res.cards && res.cards.length) {
        var combo = Cards.parse(res.cards);
        if (!combo || (G.lastCombo && !Cards.canBeat(combo, G.lastCombo))) {
          doPass(seat);
        } else {
          doPlay(seat, res.cards, combo);
        }
      } else {
        doPass(seat);
      }
    });
  }

  /* ---------- 玩家回合 ---------- */

  function humanTurn() {
    G.selected = [];
    G.hints = [];
    G.hintIdx = 0;
    renderHand();
    updateActionBar();
    Sound.play('turn');
    startTimer();
  }

  function updateActionBar() {
    var myTurn = (G.phase === 'playing' && G.turn === 0 && !G.busy);
    var sel = selectedCards();
    var combo = sel.length ? Cards.parse(sel) : null;
    var canPlay = myTurn && combo && (!G.lastCombo || Cards.canBeat(combo, G.lastCombo));
    UI.setActions({
      play: !!canPlay,
      pass: myTurn && !!G.lastCombo,
      hint: myTurn && hintEnabled(),
      clear: myTurn && sel.length > 0,
      playText: (myTurn && G.timeLeft > 0) ? ('出牌 (' + G.timeLeft + ')') : '出牌'
    });
  }

  /**
   * 提交出牌/不要后立刻锁住操作栏。
   * 出牌动画播放期间（约 340ms）下一个 humanTurn() 还没执行，若沿用上一回合
   * 的按钮状态，玩家点「出牌」会拿旧选牌去压自己刚打出的那一手，弹出莫名其妙
   * 的「大不过上家」。这里先全部禁用，等 humanTurn() 再按需点亮。
   */
  function lockActions() {
    G.selected = [];
    G.hints = [];
    UI.setActions({ play: false, pass: false, hint: false, clear: false });
  }

  function selectedCards() {
    var hand = P(0).hand;
    var ids = new Set(G.selected);
    return hand.filter(function (c) { return ids.has(c.id); });
  }

  function onCardClick(card) {
    if (G.phase !== 'playing' || G.turn !== 0 || G.busy) return;
    var i = G.selected.indexOf(card.id);
    if (i >= 0) { G.selected.splice(i, 1); Sound.play('deselect'); }
    else { G.selected.push(card.id); Sound.play('select'); }
    renderHand();
    updateActionBar();
  }

  /** 拖动连选：indices 是划过的手牌下标（与手牌数组顺序一致），合并进当前选牌 */
  function onCardDrag(indices, mode) {
    if (G.phase !== 'playing' || G.turn !== 0 || G.busy) return;
    var hand = P(0).hand;
    var changed = false;
    indices.forEach(function (i) {
      var c = hand[i];
      if (!c) return;
      var pos = G.selected.indexOf(c.id);
      if (mode === 'deselect') {
        if (pos >= 0) { G.selected.splice(pos, 1); changed = true; }
      } else if (pos < 0) {
        G.selected.push(c.id); changed = true;
      }
    });
    if (!changed) return;
    renderHand();
    updateActionBar();
  }

  function clearSelection() {
    G.selected = [];
    renderHand();
    updateActionBar();
  }

  /** 大师模式禁用玩家提示（按钮与快捷键 H 同时失效） */
  function hintEnabled() { return G.difficulty !== 'master'; }

  function doHint() {
    if (G.phase !== 'playing' || G.turn !== 0 || G.busy) return;
    if (!hintEnabled()) { UI.toast('大师模式下提示已禁用'); return; }
    var hand = P(0).hand;
    if (!G.hints.length) {
      G.hints = AI.hintCandidates(hand, G.lastCombo);
      G.hintIdx = -1;
    }
    if (!G.hints.length) {
      UI.toast(G.lastCombo ? '没有能压过的牌，只能不要' : '没有可出的牌');
      return;
    }
    G.hintIdx = (G.hintIdx + 1) % G.hints.length;
    var cards = G.hints[G.hintIdx];
    G.selected = cards.map(function (c) { return c.id; });
    renderHand();
    updateActionBar();
    var cb = Cards.parse(cards);
    UI.toast('提示：' + Cards.describe(cb));
    Sound.play('select');
  }

  function tryPlay() {
    if (G.phase !== 'playing' || G.turn !== 0 || G.busy) return;
    var sel = selectedCards();
    if (!sel.length) { UI.toast('请先选牌'); return; }
    var combo = Cards.parse(sel);
    if (!combo) { UI.toast('牌型不合法'); Sound.play('warn'); return; }
    if (G.lastCombo && !Cards.canBeat(combo, G.lastCombo)) {
      UI.toast('大不过上家');
      Sound.play('warn');
      return;
    }
    clearTimer();
    doPlay(0, sel, combo);
  }

  function tryPass() {
    if (G.phase !== 'playing' || G.turn !== 0 || G.busy) return;
    if (!G.lastCombo) { UI.toast('本轮由你先出，不能不要'); return; }
    clearTimer();
    doPass(0);
  }

  /* ---------- 执行出牌 / 不要 ---------- */

  function doPlay(seat, cards, combo) {
    UI.clearTurnClock();
    lockActions();
    var p = P(seat);
    var ids = new Set(cards.map(function (c) { return c.id; }));
    p.hand = p.hand.filter(function (c) { return !ids.has(c.id); });
    G.played = G.played.concat(cards);

    G.lastCombo = combo;
    G.lastSeat = seat;
    G.passCount = 0;

    if (seat === G.landlord) G.landlordPlays++;
    else G.farmerPlays++;

    var isBomb = (combo.type === CT.BOMB || combo.type === CT.ROCKET);
    if (isBomb) {
      G.multiplier *= 2;
      G.bombs++;
      UI.bombEffect();
      Sound.play(combo.type === CT.ROCKET ? 'rocket' : 'bomb');
      UI.toast((combo.type === CT.ROCKET ? '王炸' : '炸弹') + '！倍数 ×' + G.multiplier, 1500);
    } else {
      Sound.play('play');
    }

    UI.showPlay(seat, cards, combo, { bomb: isBomb });
    if (typeof Voice !== 'undefined') Voice.announcePlay(seat, combo);
    log(P(seat).name + ' 出 ' + Cards.describe(combo) +
      '（' + cards.map(function (c) { return c.label; }).join(' ') + '）', seat === 0);

    G.selected = [];
    G.hints = [];
    if (seat === 0) renderHand();
    renderAll();
    refreshCounter();
    updateMood();

    if (p.hand.length === 0) { settle(seat); return; }

    G.turn = (seat + 1) % 3;
    later(isBomb ? 620 : 340, nextTurn);
  }

  function doPass(seat) {
    UI.clearTurnClock();
    // 硬性不变量：领出方（无待跟牌）不能不要。若决策层出现任何异常
    // （理论上不应发生），兜底出「最优拆解的第一手」——仍来自算法的
    // 最优化决策，而非随手出最小单张；若连拆解都失败，才退到最小单张。
    if (!G.lastCombo) {
      var h = P(seat).hand;
      var pick = null, pickCombo = null;
      try {
        var dec = Dec.decompose(h);
        if (dec && dec.hands.length) {
          pick = dec.hands[0];
          pickCombo = Cards.parse(pick);
        }
      } catch (e) { /* 拆解异常则走最后保险 */ }
      if (!pickCombo) {
        pick = h[h.length - 1];
        pickCombo = pick ? Cards.parse([pick]) : null;
      }
      if (pickCombo) {
        if (seat !== 0) log(P(seat).name + ' 领出', seat === 0);
        doPlay(seat, pick, pickCombo);
      }
      return;
    }
    lockActions();
    G.passCount++;
    UI.showPass(seat);
    Sound.play('pass');
    if (typeof Voice !== 'undefined') Voice.announcePass(seat);
    log(P(seat).name + ' 不要', seat === 0);
    G.selected = [];
    G.hints = [];
    if (seat === 0) { clearTimer(); renderHand(); }
    renderAll();

    G.turn = (seat + 1) % 3;
    later(300, nextTurn);
  }

  /* ---------- 玩家倒计时 ---------- */

  function startTimer() {
    clearTimer();
    var gen = G.gen;
    G.timeLeft = TURN_SECONDS;
    G.timer = setInterval(function () {
      if (G.gen !== gen || G.phase !== 'playing' || G.turn !== 0) { clearTimer(); return; }
      if (UI.overlayShown()) return;   // 帮助/战绩等弹窗打开时暂停倒计时，读完再来
      G.timeLeft--;
      if (G.timeLeft <= 0) {
        clearTimer();
        autoPlay();
        return;
      }
      if (G.timeLeft <= 5) Sound.play('warn');
      UI.tickTurnClock(G.timeLeft);
      updateActionBar();
    }, 1000);
    updateActionBar();
  }

  function clearTimer() {
    if (G.timer) { clearInterval(G.timer); G.timer = null; }
    G.timeLeft = 0;
  }

  function autoPlay() {
    if (G.phase !== 'playing' || G.turn !== 0 || G.busy) return;
    UI.toast('超时，系统自动出牌');
    if (G.lastCombo) { doPass(0); return; }
    var list = AI.hintCandidates(P(0).hand, null);
    if (list.length) {
      var cards = list[0];
      var combo = Cards.parse(cards);
      if (combo) { doPlay(0, cards, combo); return; }
    }
    // 兜底：出最小的一张
    var h = P(0).hand;
    var single = [h[h.length - 1]];
    doPlay(0, single, Cards.parse(single));
  }

  /* ================= 结算 ================= */

  function settle(winner) {
    G.phase = 'over';
    clearTimer();
    UI.clearTurnClock();
    UI.clearAllSlots();

    var landlordWin = (winner === G.landlord);
    var spring = false, antiSpring = false;

    if (landlordWin && G.farmerPlays === 0) { spring = true; G.multiplier *= 2; }
    if (!landlordWin && G.landlordPlays === 1) { antiSpring = true; G.multiplier *= 2; }

    var mult = G.multiplier;
    var base = G.baseScore;
    var iAmLandlord = (G.landlord === 0);
    var iWin = (winner === 0) || (iAmLandlord && landlordWin) ||
      (!iAmLandlord && !landlordWin);
    var unit = base * mult;
    var delta = iAmLandlord ? (iWin ? unit * 2 : -unit * 2) : (iWin ? unit : -unit);

    Store.recordGame({
      role: iAmLandlord ? 'landlord' : 'farmer',
      win: iWin, delta: delta, bombs: G.bombs, spring: spring, antiSpring: antiSpring
    });

    if (spring) { UI.springBanner('春 天'); Sound.play('spring'); }
    if (antiSpring) { UI.springBanner('反 春 天'); Sound.play('spring'); }
    Sound.play(iWin ? 'win' : 'lose');

    var detailRows = [
      ['获胜方', landlordWin ? '地主' : '农民'],
      ['我的身份', iAmLandlord ? '地主' : '农民'],
      ['我的得分', (delta >= 0 ? '+' : '') + delta + ' 分'],
      ['底分', base],
      ['叫分倍数', '×' + G.bid.max],
      ['总倍数', '×' + mult],
      ['炸弹', G.bombs + ' 个'],
      ['春天', spring ? '是（×2）' : (antiSpring ? '反春天（×2）' : '无')]
    ].map(function (r) {
      return '<div class="kv"><span>' + r[0] + '</span><b>' + r[1] + '</b></div>';
    }).join('');

    // 余牌画到牌桌各家座位对应的角落（我方在手牌区可见，不重复），
    // 点「复盘牌桌」隐藏面板即可回看；结算面板只保留本局明细（两栏流排）
    UI.showRemainCards(
      G.players
        .filter(function (p) { return p.seat !== winner; })
        .map(function (p) { return { seat: p.seat, cards: p.hand.slice() }; })
    );

    G.settleHtml =
      '<div class="settle-title ' + (iWin ? 'win' : 'lose') + '">' +
      (iWin ? '胜 利' : '失 败') + '</div>' +
      '<div class="sec"><h4>本局明细</h4><div class="kv-cols">' + detailRows + '</div></div>';
    showSettle();

    log('—— ' + P(winner).name + ' 获胜，' + (iWin ? '我 +' : '我 ') + delta + ' 分 ——', true);
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
          UI.showRecall(UI.DOM.playArea, '查看结算', showSettle);
        }
      },
      { text: '换个场次', cls: 'ghost', onClick: function () { UI.hideRecall(); enterLobby(); } }
    ], 'wide');
  }

  /* ================= 选场大厅 ================= */

  /** 回到选场大厅：作废当前对局、抽取一批新的对手网名（「换个桌子换了批牌友」） */
  function enterLobby() {
    G.gen++;
    clearTimer();
    UI.clearTurnClock();
    UI.hideRecall();
    G.settleHtml = null;
    G.phase = 'lobby';
    G.thinkingSeat = -1;
    G.busy = false;
    rollOpponents();
    UI.closeFloat();
    UI.closeDialog();
    UI.clearAllSlots();
    UI.setActions({ play: false, pass: false, hint: false, clear: false });
    highlightLobbyRooms();
    UI.showLobby();
    if (G.players.length === 3) renderAll();
  }

  /* ================= 弹窗内容 ================= */

  function showStats() {
    var s = Store.getStats();
    var wr = s.games ? ((s.landlordWins + s.farmerWins) / s.games * 100).toFixed(1) : '0.0';
    var lwr = s.landlordGames ? (s.landlordWins / s.landlordGames * 100).toFixed(1) : '0.0';
    var fwr = s.farmerGames ? (s.farmerWins / s.farmerGames * 100).toFixed(1) : '0.0';

    UI.showDialog(
      '<h2>战 绩 统 计</h2>' +
      '<div class="sec"><h4>总览</h4>' +
      '<div class="kv"><span>总场次</span><b>' + s.games + ' 局</b></div>' +
      '<div class="kv"><span>总胜率</span><b>' + wr + '%</b></div>' +
      '<div class="kv"><span>累计积分</span><b>' + s.score + '</b></div>' +
      '<div class="kv"><span>当前连胜</span><b>' + s.streak + '</b></div>' +
      '<div class="kv"><span>最高连胜</span><b>' + s.bestStreak + '</b></div>' +
      '</div>' +
      '<div class="sec"><h4>地主</h4>' +
      '<div class="kv"><span>场次 / 胜场</span><b>' + s.landlordGames + ' / ' + s.landlordWins + '</b></div>' +
      '<div class="kv"><span>胜率</span><b>' + lwr + '%</b></div>' +
      '</div>' +
      '<div class="sec"><h4>农民</h4>' +
      '<div class="kv"><span>场次 / 胜场</span><b>' + s.farmerGames + ' / ' + s.farmerWins + '</b></div>' +
      '<div class="kv"><span>胜率</span><b>' + fwr + '%</b></div>' +
      '</div>' +
      '<div class="sec"><h4>其他</h4>' +
      '<div class="kv"><span>打出炸弹</span><b>' + s.bombs + ' 个</b></div>' +
      '<div class="kv"><span>春天次数</span><b>' + s.springs + ' 次</b></div>' +
      '<div class="kv"><span>反春天次数</span><b>' + (s.antiSprings || 0) + ' 次</b></div>' +
      '<div class="kv"><span>存储方式</span><b>' + (Store.persistent ? '本地持久化' : '临时内存') + '</b></div>' +
      '</div>',
      [
        { text: '清空战绩', cls: 'ghost', onClick: function () { Store.resetStats(); UI.toast('战绩已清空'); } },
        { text: '关闭', cls: 'gold' }
      ]
    );
  }

  function showHelp() {
    UI.showDialog(
      '<h2>玩 法 规 则</h2>' +
      '<div class="sec"><h4>牌型（由小到大）</h4>' +
      '<p>单张 · 对子 · 三张 · 三带一 · 三带二 · 顺子（≥5 连）· 连对（≥3 对）· 飞机 · 飞机带单 · 飞机带对 · 四带二 · 四带两对 · 炸弹 · 王炸</p>' +
      '<p>2 和王不能进入顺子 / 连对 / 飞机；同类型同长度才能比大小；炸弹可压任意非炸弹牌型。</p>' +
      '</div>' +
      '<div class="sec"><h4>流程</h4>' +
      '<p>发牌 17 张 ×3 + 底牌 3 张 → 叫分抢地主（1/2/3 分）→ 加倍 → 出牌 → 结算</p>' +
      '<p>地主先出，之后逆时针轮转；两家都「不要」时，最后出牌者重新领出。</p>' +
      '</div>' +
      '<div class="sec"><h4>倍数</h4>' +
      '<p>叫分倍数（1~3）× 加倍（×2，超级加倍 ×4）× 每个炸弹 / 王炸（×2）× 春天（×2）</p>' +
      '<p>地主赢输按双倍计算：地主 ±2×底分×倍数，农民 ±底分×倍数。</p>' +
      '</div>' +
      '<div class="sec"><h4>操作</h4>' +
      '<p>点击手牌选中 / 取消；<b>按住并横向拖动可连选一排牌</b>，划过的牌全部选中。</p>' +
      '<p>再点「出牌」确认；「提示」可循环切换可出的组合。</p>' +
      '<p>回合倒计时 ' + TURN_SECONDS + ' 秒，超时会自动不要或自动出最小的一手。</p>' +
      '<p>顶栏 🗣 同时开关<b>音效与语音播报</b>：任何一方出牌都会念出牌型（对二、三带一、不要…）。</p>' +
      '<p>语音引擎：' + (typeof Voice !== 'undefined' ? Voice.engineText() : '提示音') + '。</p>' +
      '</div>',
      [{ text: '知道了', cls: 'gold' }]
    );
  }

  /* ================= 初始化 ================= */

  function init() {
    UI.bindDom();
    UI.setCardClickHandler(onCardClick);
    UI.setCardDragHandler(onCardDrag);

    var prefs = Store.getPrefs();
    G.difficulty = prefs.difficulty || 'hard';
    // 老存档兼容：中等档已并入高手（三档收敛为 新手/高手/大师）
    if (G.difficulty === 'normal') G.difficulty = 'hard';
    G.baseScore = prefs.baseScore || 100;
    applyAudioPower();
    Bgm.setVolume(prefs.musicVolume === undefined ? 0.4 : prefs.musicVolume);

    syncTopbar();

    UI.el('btnPlay').addEventListener('click', tryPlay);
    UI.el('btnPass').addEventListener('click', tryPass);
    UI.el('btnHint').addEventListener('click', doHint);
    UI.el('btnClear').addEventListener('click', clearSelection);

    /** 🗣 开关同时控制「语音播报 + 音效」，🎵 只管背景音乐 */
    function applyAudioPower() {
      var p = Store.getPrefs();
      Sound.setEnabled(p.voice !== false);
      Bgm.setEnabled(p.music !== false);
      if (typeof Voice !== 'undefined') Voice.setEnabled(p.voice !== false);
    }

    // 背景音乐：独立开关 + 音量滑块
    UI.el('btnMusic').addEventListener('click', function () {
      var on = !Store.getPrefs().music;
      Store.setPrefs({ music: on });
      applyAudioPower();
      syncTopbar();
      if (on) UI.toast('背景音乐已开启');
      else UI.toast('背景音乐已关闭');
      Sound.play('select');
    });
    UI.el('volMusic').addEventListener('input', function (e) {
      var v = Number(e.target.value) / 100;
      Bgm.setVolume(v);
      Store.setPrefs({ musicVolume: v });
    });

    // 🗣：音效 + 语音播报一起开关
    UI.el('btnVoice').addEventListener('click', function () {
      var on = Store.getPrefs().voice === false;   // 翻转
      Store.setPrefs({ voice: on });
      applyAudioPower();
      syncTopbar();
      if (on) Voice.speak('语音播报已开启');
      else UI.toast('音效与语音已关闭');
      Sound.play('select');
    });

    UI.el('btnStats').addEventListener('click', function () {
      if (global.App && global.App.current === 'mj') { global.MjGame.showStats(); return; }
      showStats();
    });
    UI.el('btnHelp').addEventListener('click', function () {
      if (global.App && global.App.current === 'mj') { global.MjGame.showHelp(); return; }
      showHelp();
    });

    // 选场大厅：点击场次按钮 → 记住难度，立即开局
    var roomBtns = UI.el('lobby').querySelectorAll('button');
    for (var ri = 0; ri < roomBtns.length; ri++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var d = btn.dataset.d;
          if (!d || G.phase !== 'lobby') return;
          G.difficulty = d;
          Store.setPrefs({ difficulty: d });
          UI.setHintVisible(hintEnabled());   // 大师档整局隐藏提示按钮
          UI.hideLobby();
          newGame();
        });
      })(roomBtns[ri]);
    }

    // 对局结束后，只要关掉了所有弹窗（含战绩/规则），就回到选场大厅
    // （仅当当前游戏是斗地主 —— 麻将模块注册了自己的处理器）
    UI.addDialogCloseHandler(function () {
      if (global.App && global.App.current !== 'ddz') return;
      if (G.phase === 'over') enterLobby();
    });

    document.addEventListener('keydown', function (e) {
      if (G.phase !== 'playing' || G.turn !== 0 || G.busy) return;
      if (UI.overlayShown()) return;   // 弹窗打开时键盘不落到牌桌上（Esc 不再误触「不要」）
      if (e.key === 'Enter') tryPlay();
      else if (e.key === ' ' || e.key === 'Escape') { e.preventDefault(); tryPass(); }
      else if (e.key.toLowerCase() === 'h') doHint();
    });

    // 首次交互后再启动音频上下文（浏览器策略要求），
    // 同时预热语音引擎（部分安卓 TTS 需要手势内先 speak 过一次）
    document.addEventListener('pointerdown', function once() {
      Sound.resume();
      if (typeof Voice !== 'undefined') Voice.warmup();
      if (Bgm.isEnabled()) Bgm.start();   // 音乐也依赖用户首次交互
      document.removeEventListener('pointerdown', once);
    });

    // 初始不再自动开局 —— 由 App 的游戏模式大厅接管（选斗地主后调用 enterLobby）
  }

  /** 切回游戏模式大厅时暂停当前局面 */
  function suspend() {
    G.gen++;
    clearTimer();
    UI.clearTurnClock();
    UI.hideRecall();
    G.settleHtml = null;
    G.phase = 'lobby';
    G.thinkingSeat = -1;
    G.busy = false;
    UI.hideLobby();
    UI.closeFloat();
  }

  /** 大厅里高亮上次选择的场次 */
  function highlightLobbyRooms() {
    var roomBtns = UI.el('lobby').querySelectorAll('button');
    for (var i = 0; i < roomBtns.length; i++) {
      roomBtns[i].classList.toggle('last', roomBtns[i].dataset.d === G.difficulty);
    }
  }

  /** 局势情绪：有人快走完或倍数飙升时切换紧张型旋律 */
  function updateMood() {
    if (typeof Bgm === 'undefined' || !Bgm.isEnabled()) return;
    if (G.phase !== 'playing') { Bgm.setMood('calm'); return; }
    var minLeft = 20;
    for (var i = 0; i < G.players.length; i++) {
      if (G.players[i].hand.length < minLeft) minLeft = G.players[i].hand.length;
    }
    var tense = (minLeft <= 2) || (G.multiplier >= 8);
    Bgm.setMood(tense ? 'tense' : 'calm');
  }

  function syncTopbar() {
    var mb = UI.el('btnMusic');
    if (mb) {
      mb.textContent = Bgm.isEnabled() ? '🎵' : '🚫';
      mb.classList.toggle('off', !Bgm.isEnabled());
    }
    var vs = UI.el('volMusic');
    if (vs) vs.value = String(Math.round(Bgm.getVolume() * 100));

    var vb = UI.el('btnVoice');
    if (vb) {
      var vOn = (typeof Voice !== 'undefined') && Voice.isEnabled();
      vb.textContent = vOn ? '🗣' : '🤫';
      vb.classList.toggle('off', !vOn);
      vb.title = vOn ? '音效 + 语音播报开关（点击关闭）' : '音效 + 语音播报已关闭（点击开启）';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.Game = { G: G, newGame: newGame, enterLobby: enterLobby, suspend: suspend,
    hintEnabled: hintEnabled, rollOpponents: rollOpponents,
    handStrength: handStrength, riggedDeck: riggedDeck };

})(typeof window !== 'undefined' ? window : globalThis);
