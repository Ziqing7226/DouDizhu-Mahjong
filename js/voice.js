/* 斗地主&麻将 · 棋牌合集 —— 纯前端单机游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * voice.js —— 出牌语音播报（两级引擎 + 严格中文路由）
 *
 * 1. 系统 TTS（Web Speech API）：
 *    a) 检测到中文音色 → 显式指定音色播报（音质最好，可分男女声）；
 *    b) 音色列表为空（安卓 Chrome 平台特性：getVoices() 常返回空列表，
 *       但设置 utterance.lang='zh-CN' 后系统会路由到自带中文引擎）
 *       → 「lang-only」模式播报，仍由系统 TTS 发标准普通话。
 *    音色列表异步就绪（voiceschanged）后自动升级 / 恢复到 a)。
 * 2. 语义音效（audio.js 实时合成）：浏览器完全没有 speechSynthesis 时，
 *    每个事件用独立辨识音（叫分叮、对子双击、炸弹轰、胡牌锣……）。
 *
 * 历史教训（为什么不再用 meSpeak/eSpeak 本地合成）：
 *   eSpeak 的中文是共振峰合成，四声渲染缺失、双元音断裂
 *   （espeak-ng #1370/#1028/#1275），在手机上听感近似乱码，
 *   且其同步合成阻塞主线程——曾导致安卓端「播报即卡顿」。
 *   参数调优无法修复引擎级缺陷，故整层移除。
 *
 * 防乱码铁律：中文文本绝不交给非中文音色（宁可不出声也不出怪音）。
 *
 * iPad / iOS 注意：系统静音键（侧边开关）会屏蔽 WebAudio 与 TTS，
 * 属硬件行为，代码无法绕过，请检查静音键。
 * ========================================================================== */
(function (global) {
  'use strict';

  var synth = global.speechSynthesis || null;
  var ttsSupported = !!(synth && global.SpeechSynthesisUtterance);
  var enabled = true;

  /* 引擎状态：'tts'（有中文音色）→ 'tts-lang'（有 synth、音色列表空，靠 lang 路由）
   * → 'sfx'（无 speechSynthesis）。voiceschanged 晚到时可从下往上恢复。 */
  var engine = ttsSupported ? 'tts-lang' : 'sfx';
  var ttsVoicesReady = false;    // 是否确认有可用中文音色

  /* ---- 音色挑选：各家引擎的中文音色命名不统一，按名字猜男女 ---- */
  var MALE_RE = /yunxi|yunjian|yunyang|yunye|kangkang|liang|male|男声|康康|云健|云希|云扬/i;
  var FEMALE_RE = /xiaoxiao|xiaoyi|yunxia|xiaobei|xiaoni|huihui|yaoyao|tingting|meijia|zhiping|female|女声|晓晓|惠惠|婷婷|ting-ting|tingting|hui/i;

  var voices = { male: null, female: null, any: null, maleIsFemale: false };

  function pickVoices() {
    if (!ttsSupported) return;
    var list;
    try { list = synth.getVoices() || []; } catch (e) { return; }
    // 只认中文音色：lang 以 zh 开头，或名字带 Chinese/中文/普通话。
    // 绝不退而求其次用非中文音色念汉字（那就是「乱码」的第二条来源）。
    var zh = list.filter(function (v) {
      return /^zh/i.test(v.lang || '') || /Chinese|中文|普通话/i.test(v.name || '');
    });
    if (!zh.length) return;                      // 列表空 / 只有外文音色 → 保持现状
    // 优先本地音色（离线可用、不依赖 Google 网络音色的静默失败）
    zh.sort(function (a, b) { return (b.localService ? 1 : 0) - (a.localService ? 1 : 0); });
    voices.male = null; voices.female = null; voices.any = zh[0] || null;
    for (var i = 0; i < zh.length; i++) {
      var nm = zh[i].name || '';
      if (!voices.male && MALE_RE.test(nm)) voices.male = zh[i];
      if (!voices.female && FEMALE_RE.test(nm)) voices.female = zh[i];
    }
    // 女声兜底：没匹配到就用第一个中文音色
    if (!voices.female) voices.female = voices.any;
    // 男声兜底：挑一个与女声不同名的中文音色；实在没有就共用（靠音高拉开反差）
    if (!voices.male) {
      for (var k = 0; k < zh.length; k++) {
        if ((zh[k].name || '') !== (voices.female && voices.female.name)) { voices.male = zh[k]; break; }
      }
    }
    voices.maleIsFemale = !voices.male ||
      (voices.female && voices.male.name === voices.female.name);
    if (!voices.male) voices.male = voices.female;
    ttsVoicesReady = true;
    // 晚到的音色列表：从 lang-only / 音效层恢复到最佳层
    if (engine !== 'tts') engine = 'tts';
  }
  if (ttsSupported) {
    pickVoices();
    // 音色列表多数浏览器是异步就绪的，两种监听方式都挂上
    if (typeof synth.addEventListener === 'function') {
      synth.addEventListener('voiceschanged', pickVoices);
    } else if ('onvoiceschanged' in synth) {
      synth.onvoiceschanged = pickVoices;
    }
  }

  /* ---------------- 第一层：系统 TTS ---------------- */

  var queueCount = 0;       // 待播计数（队列积压时丢弃旧播报，保持节奏）
  var lastQueueAt = 0;      // 部分安卓 onend 永不回调 → 计数会泄漏，按时间兜底复位

  function ttsSpeak(text, gender, excitement) {
    try {
      var now = Date.now();
      if (queueCount >= 2 || now - lastQueueAt > 8000) {
        try { synth.cancel(); } catch (e) { /* 忽略 */ }
        queueCount = 0;
      }
      var isMale = gender === 'male';
      // 系统只有一个中文音色时男女共用，靠音高/语速拉开反差
      var sameVoice = isMale && voices.maleIsFemale;
      var v = isMale ? voices.male : (voices.female || voices.any);
      var u = new global.SpeechSynthesisUtterance(text);
      if (ttsVoicesReady && v) {
        u.voice = v;
        u.lang = v.lang || 'zh-CN';
      } else {
        // lang-only：安卓 Chrome 音色列表为空时，靠系统按语言路由中文引擎
        u.lang = 'zh-CN';
      }
      // 轻快的打牌情绪：语速略快，音高按性别微调并带随机起伏，避免机械感
      u.rate = (sameVoice ? 1.0 : 1.15) + Math.random() * 0.1 + (excitement ? 0.05 : 0);
      u.pitch = (sameVoice ? 0.6 : (isMale ? 0.95 : 1.15)) +
        (Math.random() * 0.1 - 0.05) + (excitement ? 0.1 : 0);
      u.volume = 1;
      u.onend = u.onerror = function () {
        if (queueCount > 0) queueCount--;
        // iOS：TTS 抢占音频会话导致 WebAudio（BGM/音效）中断，播完即尝试唤醒
        if (global.Sound && global.Sound.resume) {
          try { global.Sound.resume(); } catch (e) { /* 忽略 */ }
        }
      };
      queueCount++;
      lastQueueAt = now;
      synth.speak(u);
    } catch (e) { /* 播报失败不影响游戏 */ }
  }

  /**
   * 首次用户手势时调用：预热系统 TTS ——
   * 部分安卓浏览器必须先在人手势内 speak 过一次才出声。
   * 同时做健康探测：预热utterance 若 2.5 秒内连 onstart 都没有
   * （安卓/鸿蒙部分浏览器有 API 无引擎），降级为语义提示音。
   */
  var warmupStarted = false;
  function warmup() {
    if (!ttsSupported) return;
    pickVoices();
    try {
      var u = new global.SpeechSynthesisUtterance(' ');
      u.volume = 0;
      u.lang = 'zh-CN';
      u.onstart = function () { warmupStarted = true; };
      synth.speak(u);
    } catch (e) { /* 忽略 */ }
    setTimeout(function () {
      pickVoices();
      if (!ttsVoicesReady && !warmupStarted && engine === 'tts-lang') {
        engine = 'sfx';   // 真·无语音能力：以后播报走提示音
      }
    }, 2500);
  }

  /* ---------------- 第二层：语义音效 ---------------- */

  /** 事件 → 辨识音（audio.js 合成，零依赖） */
  function cueFor(text, gender, cue) {
    var S = global.Sound;
    if (!S) return;
    S.play(cue || 'vPlay');
  }

  /* ---------------- 点数 → 口头叫法 ---------------- */

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

  /* ---------------- 统一播报入口 ---------------- */

  function speak(text, gender, excitement, cue) {
    if (!enabled || !text) return;
    if (engine === 'tts' || engine === 'tts-lang') {
      ttsSpeak(text, gender, excitement);
      return;
    }
    cueFor(text, gender, cue);   // 第二层：语义音效
  }

  /** 每个座位固定一种音色：斗地主（3 家）与麻将（4 家）通用，相邻座位不同声 */
  var SEAT_GENDER = ['female', 'male', 'female', 'male'];
  function seatGender(seat) { return SEAT_GENDER[seat] || 'female'; }

  function announcePlay(seat, combo) {
    var Cards = global.Cards;
    var t = comboText(combo);
    if (!t) return;
    var CT = Cards && Cards.CT;
    var cue = 'vPlay';
    if (CT) {
      if (combo.type === CT.ROCKET) cue = 'rocket';
      else if (combo.type === CT.BOMB) cue = 'bomb';
      else if (combo.type === CT.SINGLE) cue = 'vSingle';
      else if (combo.type === CT.PAIR) cue = 'vPair';
      else if (combo.type === CT.STRAIGHT || combo.type === CT.DOUBLE_STRAIGHT ||
        combo.type === CT.TRIPLE_STRAIGHT || combo.type === CT.AIRPLANE_ONE ||
        combo.type === CT.AIRPLANE_PAIR) cue = 'vStraight';
      else cue = 'vTriple';
    }
    speak(t, seatGender(seat), cue === 'bomb' || cue === 'rocket', cue);
  }

  function announcePass(seat) {
    speak(Math.random() < 0.5 ? '不要' : '过', seatGender(seat), false, 'pass');
  }

  /** 叫分：0=不叫，1/2/3 = 一分/两分/三分 */
  function announceBid(seat, score) {
    var texts = ['不叫', '一分', '两分', '三分'];
    speak(texts[score] || '', seatGender(seat), score === 3, 'bid');
  }

  /** 地主确定：由地主座位的声音念「叫地主」 */
  function announceLandlord(seat) {
    speak('叫地主！', seatGender(seat), true, 'vLandlord');
  }

  /** 加倍：0=不加倍，1=加倍，2=超级加倍 */
  function announceDouble(seat, level) {
    var t = level === 2 ? '超级加倍！' : (level === 1 ? '加倍！' : '不加倍');
    speak(t, seatGender(seat), level > 0, 'double');
  }

  function setEnabled(v) {
    enabled = !!v;
    if (!enabled) {
      try { synth && synth.cancel(); } catch (e) { /* 忽略 */ }
    }
  }
  function isEnabled() { return enabled; }

  /** 调试 / 设置页展示当前引擎 */
  function engineInfo() {
    return {
      engine: engine,
      tts: ttsSupported, ttsVoices: ttsVoicesReady
    };
  }

  /** 当前语音引擎的人类可读描述（帮助面板用，诚实呈现能力） */
  function engineText() {
    if (!ttsSupported) return '提示音（当前浏览器不支持语音合成）';
    if (engine === 'tts') return '系统语音合成（中文音色）';
    if (engine === 'tts-lang') return '系统语音合成（跟随系统设置）';
    return '提示音（当前浏览器/设备无可用语音引擎）';
  }

  global.Voice = {
    supported: ttsSupported,
    comboText: comboText,
    announcePlay: announcePlay,
    announcePass: announcePass,
    announceBid: announceBid,
    announceLandlord: announceLandlord,
    announceDouble: announceDouble,
    speak: function (text, gender, cue) { speak(text, gender || 'female', false, cue); },
    seatGender: seatGender,
    warmup: warmup,
    engineInfo: engineInfo,
    engineText: engineText,
    setEnabled: setEnabled,
    isEnabled: isEnabled
  };

})(typeof window !== 'undefined' ? window : globalThis);
