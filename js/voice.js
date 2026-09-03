/* 斗地主&麻将 · 棋牌合集 —— 纯前端单机游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * voice.js —— 出牌语音播报（三层引擎兜底）
 *
 * 1. 系统 TTS（Web Speech API）：Edge / 桌面 Chrome / iOS Safari 等
 *    有中文语音引擎时使用，音色最自然。
 *    兼容修复：首次用户手势预热解锁（部分安卓需先 speak 过一次）、
 *    voiceschanged 异步音色重挑、队列积压丢弃。
 * 2. meSpeak（本地 JS 合成，js/vendor/，约 1.7MB 懒加载）：
 *    系统 TTS 不可用（部分安卓 / 鸿蒙等无 TTS 引擎的浏览器）时加载，
 *    任何支持 WebAudio 的浏览器都能"说中文"，音色偏机械。
 * 3. 语义音效（audio.js 实时合成）：前两层都失败时，每个事件用
 *    独立辨识音（叫分叮、对子双击、炸弹轰、胡牌锣……），零依赖全平台可用。
 *
 * iPad / iOS 注意：系统静音键（侧边开关）会屏蔽 WebAudio 与 TTS，
 * 属硬件行为，代码无法绕过，请检查静音键。
 * ========================================================================== */
(function (global) {
  'use strict';

  var synth = global.speechSynthesis || null;
  var ttsSupported = !!(synth && global.SpeechSynthesisUtterance);
  var enabled = true;

  /* 引擎状态：'tts' → 'mespeak' → 'sfx'（逐层降级，最终稳定） */
  var engine = ttsSupported ? 'tts' : 'boot';
  var preferred = 'auto';        // auto | tts | mespeak | sfx（用户可切换，持久化）
  var ttsVoicesReady = false;    // 系统 TTS 是否确认有可用音色
  var mespeakState = 'idle';     // idle | loading | ready | failed
  var mespeakProbing = false;

  /** 用户指定引擎（自动 = 按 TTS 可用性逐层兜底；其余锁定该层） */
  function setPreferredEngine(mode) {
    if (['auto', 'tts', 'mespeak', 'sfx'].indexOf(mode) < 0) return;
    preferred = mode;
    applyPreferred();
  }

  function applyPreferred() {
    if (preferred === 'sfx') { engine = 'sfx'; return; }
    if (preferred === 'tts') {
      engine = (ttsSupported && ttsVoicesReady) ? 'tts' : 'sfx';
      return;
    }
    if (preferred === 'mespeak') {
      if (mespeakState === 'ready') { engine = 'mespeak'; return; }
      engine = 'boot';
      escalate();
      return;
    }
    // auto：系统 TTS 可用就用，否则逐层兜底
    if (ttsSupported && ttsVoicesReady) { engine = 'tts'; return; }
    escalate();
  }

  /* ---- 音色挑选：各家引擎的中文音色命名不统一，按名字猜男女 ---- */
  var MALE_RE = /yunxi|yunjian|yunyang|yunye|kangkang|liang|male|男声|康康|云健|云希|云扬/i;
  var FEMALE_RE = /xiaoxiao|xiaoyi|yunxia|xiaobei|xiaoni|huihui|yaoyao|tingting|meijia|zhiping|female|女声|晓晓|惠惠|婷婷|ting-ting|tingting|hui/i;

  var voices = { male: null, female: null, any: null, maleIsFemale: false };

  function pickVoices() {
    if (!ttsSupported) return;
    var list;
    try { list = synth.getVoices() || []; } catch (e) { return; }
    if (!list.length) return;                    // 还没就绪 / 无引擎
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

  var queueCount = 0;   // 待播计数（队列积压时丢弃旧播报，保持节奏）

  function ttsSpeak(text, gender, excitement) {
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

  /**
   * 首次用户手势时调用：
   * 1) 预热系统 TTS —— 部分安卓浏览器必须先在人手势内 speak 过一次才出声；
   * 2) 若 2.5s 后仍没有任何可用音色（无 TTS 引擎的浏览器），降级到 meSpeak。
   */
  function warmup() {
    if (!ttsSupported) { escalate(); return; }
    pickVoices();
    try {
      var u = new global.SpeechSynthesisUtterance(' ');
      u.volume = 0;
      synth.speak(u);
    } catch (e) { /* 忽略 */ }
    // 给异步音色列表一点时间，仍为空 → 无引擎 → 降级
    setTimeout(function () {
      pickVoices();
      if (!ttsVoicesReady) escalate();
    }, 2500);
  }

  /* ---------------- 第二层：meSpeak 本地合成 ---------------- */

  var MS_BASE = 'js/vendor/';
  var MS_FILES = ['mespeak.js', 'mespeak-core.js', 'mespeak_config.json', 'mespeak-zh.json'];

  function escalate() {
    // 已就绪直接启用；加载中就等它（poll 由首次加载驱动）
    if (mespeakState === 'ready') { engine = 'mespeak'; return; }
    if (mespeakState === 'loading') { engine = 'boot'; return; }
    if (engine === 'sfx' && mespeakState === 'failed') return;   // 试过且失败，留在音效层
    mespeakState = 'loading';
    loadScript(MS_BASE + 'mespeak.js', function (ok) {
      if (!ok) return mespeakFail();
      var ms = global.meSpeak;
      if (!ms) return mespeakFail();
      // meSpeak v2.0.7 前端：loadCustomConfig 接受页面相对路径，
      // loadVoice 只接受「相对 mespeak.js 所在目录」的文件名（传完整路径会解析成错误地址），
      // 且回调在部分平台上不可靠 —— 统一用「发射后轮询就绪状态」驱动
      try { ms.loadCustomConfig(MS_BASE + 'mespeak_config.json'); } catch (e) { return mespeakFail(); }
      poll(function () {
        try { return ms.isConfigLoaded(); } catch (e) { return false; }
      }, 15000, function (cfgOk) {
        if (!cfgOk) return mespeakFail();
        try { ms.loadVoice('mespeak-zh.json'); } catch (e) { return mespeakFail(); }
        poll(function () {
          try { return ms.isVoiceLoaded('zh'); } catch (e) { return false; }
        }, 15000, function (vOk) {
          if (!vOk) return mespeakFail();
          // 能力探测：合成一句不抛异常即认为就绪（音色已注册是必要条件）
          try { ms.speak('好', { voice: 'zh' }); } catch (e) { return mespeakFail(); }
          mespeakState = 'ready';
          engine = 'mespeak';
          mespeakProbing = false;
        });
      });
    });
  }

  function mespeakFail() {
    mespeakState = 'failed';
    mespeakProbing = false;
    engine = 'sfx';   // 第三层：语义音效
  }

  function loadScript(src, done) {
    var s = document.createElement('script');
    s.src = src;
    s.onload = function () { done(true); };
    s.onerror = function () { done(false); };
    (document.head || document.getElementsByTagName('head')[0]).appendChild(s);
  }

  function poll(cond, timeoutMs, done) {
    var t0 = Date.now();
    (function step() {
      if (cond()) return done(true);
      if (Date.now() - t0 > timeoutMs) return done(false);
      setTimeout(step, 300);
    })();
  }

  function mespeakSpeak(text, gender, excitement) {
    try {
      // 清洗文本：全角标点/空白会被合成引擎念成杂音，全部去掉
      var clean = String(text).replace(/[！!？?，,。.～~、：:；;「」()\[\]（）\s]+/g, '');
      if (!clean) return;
      global.meSpeak.speak(clean, {
        voice: 'zh',
        amplitude: 175,
        // 男声压低音高，女声略高；语速稍慢更清楚（eSpeak 中文按字读音）
        pitch: gender === 'male' ? 30 : 56,
        speed: 152,
        wordgap: 1
      });
    } catch (e) { /* 忽略 */ }
  }

  /* ---------------- 第三层：语义音效 ---------------- */

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
    if (preferred === 'tts' && !(ttsSupported && ttsVoicesReady)) {
      cueFor(text, gender, cue);   // 指定真人但没有引擎 → 音效
      return;
    }
    if (engine === 'tts') {
      if (ttsVoicesReady) ttsSpeak(text, gender, excitement);
      // 音色未就绪期间静默跳过（warmup 很快会完成）
      return;
    }
    if (engine === 'mespeak' && mespeakState === 'ready') {
      mespeakSpeak(text, gender, excitement);
      return;
    }
    cueFor(text, gender, cue);   // 第三层：语义音效
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
      try { global.meSpeak && global.meSpeak.stop(); } catch (e) { /* 忽略 */ }
    }
  }
  function isEnabled() { return enabled; }

  /** 调试 / 设置页展示当前引擎 */
  function engineInfo() {
    return {
      engine: engine, preferred: preferred,
      tts: ttsSupported, ttsVoices: ttsVoicesReady, mespeak: mespeakState
    };
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
    setPreferredEngine: setPreferredEngine,
    setEnabled: setEnabled,
    isEnabled: isEnabled
  };

})(typeof window !== 'undefined' ? window : globalThis);
