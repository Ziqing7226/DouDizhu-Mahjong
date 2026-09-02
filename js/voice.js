/* 斗地主 —— 纯前端单机斗地主游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * voice.js —— 出牌语音播报（Web Speech API）
 * 任何一方叫分 / 叫地主 / 加倍 / 出牌 / 不要时用男声或女声念出来。
 * 语速略快、音高带随机起伏，营造轻快的打牌情绪。
 * 浏览器不支持 speechSynthesis 时整体静默降级，不影响游戏。
 * ========================================================================== */
(function (global) {
  'use strict';

  var synth = global.speechSynthesis || null;
  var supported = !!(synth && global.SpeechSynthesisUtterance);
  var enabled = true;

  /* ---- 音色挑选：各家引擎的中文音色命名不统一，按名字猜男女 ---- */
  var MALE_RE = /yunxi|yunjian|yunyang|yunye|kangkang|liang|male|男声|康康|云健|云希|云扬/i;
  var FEMALE_RE = /xiaoxiao|xiaoyi|yunxia|xiaobei|xiaoni|huihui|yaoyao|tingting|meijia|zhiping|female|女声|晓晓|惠惠|婷婷/i;

  var voices = { male: null, female: null, any: null, maleIsFemale: false };

  function pickVoices() {
    if (!supported) return;
    var list;
    try { list = synth.getVoices() || []; } catch (e) { return; }
    var zh = list.filter(function (v) {
      return /^zh/i.test(v.lang || '') || /Chinese|中文|普通话/.test(v.name || '');
    });
    if (!zh.length) zh = list;
    voices.male = null; voices.female = null; voices.any = zh[0] || null;
    for (var i = 0; i < zh.length; i++) {
      var nm = zh[i].name || '';
      if (!voices.male && MALE_RE.test(nm)) voices.male = zh[i];
      if (!voices.female && FEMALE_RE.test(nm)) voices.female = zh[i];
    }
    // 女声兜底：没匹配到就用第一个中文音色
    if (!voices.female) voices.female = voices.any;
    // 男声兜底：系统里没有公认男声时，退而求其次——
    // 挑一个「与女声不同名」的中文音色；一个都没有就共用女声，
    // 但会拉开音高/语速制造反差（见 speak）
    if (!voices.male) {
      for (var k = 0; k < zh.length; k++) {
        if ((zh[k].name || '') !== (voices.female && voices.female.name)) { voices.male = zh[k]; break; }
      }
    }
    voices.maleIsFemale = !voices.male ||
      (voices.female && voices.male.name === voices.female.name);
    if (!voices.male) voices.male = voices.female;
  }
  if (supported) {
    pickVoices();
    // 音色列表多数浏览器是异步就绪的，两种监听方式都挂上
    if (typeof synth.addEventListener === 'function') {
      synth.addEventListener('voiceschanged', pickVoices);
    } else if ('onvoiceschanged' in synth) {
      synth.onvoiceschanged = pickVoices;
    }
  }

  /* ---- 点数 → 口头叫法（沿用民间通行的叫牌习惯：J 钩、Q 圈、A 尖） ---- */
  var RANK_CN = ['', '', '', '三', '四', '五', '六', '七', '八', '九', '十',
    '钩', '圈', 'K', '尖', '二', '小王', '大王'];

  /** 牌型 → 播报文本（纯函数，便于测试）。顺子/连对只念牌型名。 */
  function comboText(combo) {
    var Cards = global.Cards;
    if (!combo || !Cards) return '';
    var CT = Cards.CT;
    switch (combo.type) {
      case CT.ROCKET: return '王炸！';
      case CT.BOMB: return '炸弹！';
      case CT.SINGLE:
        return (combo.main >= 16) ? RANK_CN[combo.main] + '！' : RANK_CN[combo.main];
      case CT.PAIR: return '对' + RANK_CN[combo.main];
      case CT.TRIPLE: return '三个' + RANK_CN[combo.main];
      case CT.TRIPLE_ONE: return '三带一';
      case CT.TRIPLE_PAIR: return '三带二';
      case CT.STRAIGHT: return '顺子';
      case CT.DOUBLE_STRAIGHT: return '连对';
      case CT.TRIPLE_STRAIGHT: return '飞机';
      case CT.AIRPLANE_ONE: return '飞机带单';
      case CT.AIRPLANE_PAIR: return '飞机带对';
      case CT.FOUR_TWO: return '四带二';
      case CT.FOUR_TWO_PAIR: return '四带两对';
      default: return Cards.CT_NAME ? (Cards.CT_NAME[combo.type] || '') : '';
    }
  }

  /* ---- 发声 ---- */

  var queueCount = 0;   // 自己维护的待播计数（队列积压时丢弃旧播报，保持节奏）

  function speak(text, gender, excitement) {
    if (!supported || !enabled || !text) return;
    try {
      if (queueCount >= 2) {
        try { synth.cancel(); } catch (e) { /* 忽略 */ }
        queueCount = 0;
      }
      var isMale = gender === 'male';
      // 系统只有一个中文音色时男女共用，靠音高/语速拉开反差
      var sameVoice = isMale && voices.maleIsFemale;
      var v = isMale ? voices.male : (voices.female || voices.any);
      var u = new global.SpeechSynthesisUtterance(text);
      if (v) { u.voice = v; u.lang = v.lang || 'zh-CN'; }
      else { u.lang = 'zh-CN'; }
      // 轻快的打牌情绪：语速略快，音高按性别微调并带随机起伏，避免机械感
      u.rate = (sameVoice ? 1.0 : 1.15) + Math.random() * 0.1 + (excitement ? 0.05 : 0);
      u.pitch = (sameVoice ? 0.6 : (isMale ? 0.95 : 1.15)) +
        (Math.random() * 0.1 - 0.05) + (excitement ? 0.1 : 0);
      u.volume = 1;
      u.onend = u.onerror = function () { if (queueCount > 0) queueCount--; };
      queueCount++;
      synth.speak(u);
    } catch (e) { /* 播报失败不影响游戏 */ }
  }

  /** 每个座位固定一种音色：玩家女声，下家男声，上家女声（相邻座位不同声，便于分辨） */
  var SEAT_GENDER = ['female', 'male', 'female'];

  function announcePlay(seat, combo) {
    var Cards = global.Cards;
    var t = comboText(combo);
    if (!t) return;
    var hot = !!(combo && Cards && (combo.type === Cards.CT.BOMB || combo.type === Cards.CT.ROCKET));
    speak(t, SEAT_GENDER[seat] || 'female', hot);
  }

  function announcePass(seat) {
    // 「不要」与「过」随机二选一，保留口语变化但不带拖腔变体
    speak(Math.random() < 0.5 ? '不要' : '过', SEAT_GENDER[seat] || 'female', false);
  }

  /** 叫分：0=不叫，1/2/3 = 一分/两分/三分 */
  function announceBid(seat, score) {
    var texts = ['不叫', '一分', '两分', '三分'];
    speak(texts[score] || '', SEAT_GENDER[seat] || 'female', score === 3);
  }

  /** 地主确定：由地主座位的声音念「叫地主」 */
  function announceLandlord(seat) {
    speak('叫地主！', SEAT_GENDER[seat] || 'female', true);
  }

  /** 加倍：0=不加倍，1=加倍，2=超级加倍 */
  function announceDouble(seat, level) {
    var t = level === 2 ? '超级加倍！' : (level === 1 ? '加倍！' : '不加倍');
    speak(t, SEAT_GENDER[seat] || 'female', level > 0);
  }

  function setEnabled(v) { enabled = !!v; if (!enabled) try { synth && synth.cancel(); } catch (e) { /* 忽略 */ } }
  function isEnabled() { return enabled; }

  global.Voice = {
    supported: supported,
    comboText: comboText,
    announcePlay: announcePlay,
    announcePass: announcePass,
    announceBid: announceBid,
    announceLandlord: announceLandlord,
    announceDouble: announceDouble,
    speak: function (text, gender) { speak(text, gender || 'female', false); },
    setEnabled: setEnabled,
    isEnabled: isEnabled
  };

})(typeof window !== 'undefined' ? window : globalThis);
