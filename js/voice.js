/* 斗地主&麻将 · 棋牌合集 —— 纯前端单机游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * voice.js —— 出牌语音播报（预录制音频包 + 语义音效兜底，两层引擎）
 *
 * 0. 预录制音频包（js/voice/*.mp3，Edge TTS YunxiaNeural 生成）：
 *    首次用户手势时批量 fetch + decodeAudioData 预加载到内存（仅 http/https；
 *    file:// 下 fetch 会被浏览器按跨域拦截，改走 HTMLAudio 兜底，同样能播）。
 *    播报时按文本精确匹配播放，全平台一致、零延迟、标准普通话。
 *    男声座位用 playbackRate 0.85 降速降调（preservesPitch=false）。
 *    全部播报均为静态短语（107 条），动态内容（如别家胡牌）也由
 *    「方位+胡了」等固定短语覆盖。
 * 1. 语义音效（audio.js 合成）：音频包未加载完成 / 缺文件时的兜底。
 *
 * 历史：曾用 meSpeak/eSpeak 本地合成（共振峰合成，中文四声缺失听感
 * 近似乱码 + 同步合成阻塞主线程导致安卓卡顿），已整层移除；
 * 系统 TTS 层在播报全部静态化后亦已移除（音色/时延不可控，
 * 且预录制包可 100% 覆盖播报文本）。
 * ========================================================================== */
(function (global) {
  'use strict';

  var enabled = true;

  /* ---- 预录制音频包 ---- */

  var audioBuffers = {};       // 播报短语 → AudioBuffer（短语即键，文件名经 fileNames 映射）
  var packLoaded = false;      // 是否已开始 / 完成加载
  var packReady = false;       // 至少加载了一个文件

  /* ---- 播报短语清单（唯一权威，与 tools/gen-voice-pack.js 保持同步） ---- */

  var MANIFESTS = [
    '三', '四', '五', '六', '七', '八', '九', '十', '钩', '圈', 'K', '尖', '二',
    '小王', '大王',
    '对三', '对四', '对五', '对六', '对七', '对八', '对九', '对十',
    '对钩', '对圈', '对K', '对尖', '对二',
    '三个三', '三个四', '三个五', '三个六', '三个七', '三个八', '三个九',
    '三个十', '三个钩', '三个圈', '三个K', '三个尖', '三个二',
    '三带一', '三带二', '顺子', '连对', '飞机', '飞机带单', '飞机带对',
    '四带二', '四带两对', '王炸', '炸弹',
    '一万', '二万', '三万', '四万', '五万', '六万', '七万', '八万', '九万',
    '一条', '二条', '三条', '四条', '五条', '六条', '七条', '八条', '九条',
    '一筒', '二筒', '三筒', '四筒', '五筒', '六筒', '七筒', '八筒', '九筒',
    '东风', '南风', '西风', '北风', '红中', '发财', '白板',
    '吃', '碰', '杠', '暗杠', '加杠', '胡了', '我胡了',
    '东位胡了', '南位胡了', '西位胡了', '北位胡了',
    '不要', '过', '不叫', '一分', '两分', '三分',
    '叫地主', '加倍', '不加倍', '超级加倍'
  ];

  /* ---- 拼音文件名映射：中文文件名在部分服务端/CDN 上有 URL 编码兼容风险
   *  （iPad 实测预加载 12/107 停滞），统一改为无声调全拼连写。
   *  多音字按全部短语中的唯一读法硬编码；107 条经脚本校验零重名。
   *  改动短语清单时必须同步 PINYIN 并重跑 tools/gen-voice-pack.js。 ---- */
  var PINYIN = {
    '三': 'san', '四': 'si', '五': 'wu', '六': 'liu', '七': 'qi', '八': 'ba',
    '九': 'jiu', '十': 'shi', '钩': 'gou', '圈': 'quan', 'K': 'K', '尖': 'jian',
    '二': 'er', '小': 'xiao', '王': 'wang', '大': 'da', '对': 'dui', '个': 'ge',
    '带': 'dai', '顺': 'shun', '子': 'zi', '连': 'lian', '飞': 'fei', '机': 'ji',
    '单': 'dan', '两': 'liang', '炸': 'zha', '弹': 'dan', '万': 'wan',
    '条': 'tiao', '筒': 'tong', '东': 'dong', '南': 'nan', '西': 'xi',
    '北': 'bei', '风': 'feng', '红': 'hong', '中': 'zhong', '发': 'fa',
    '财': 'cai', '白': 'bai', '板': 'ban', '吃': 'chi', '碰': 'peng',
    '杠': 'gang', '暗': 'an', '加': 'jia', '胡': 'hu', '了': 'le', '我': 'wo',
    '位': 'wei', '不': 'bu', '要': 'yao', '过': 'guo', '叫': 'jiao',
    '一': 'yi', '分': 'fen', '超': 'chao', '级': 'ji', '地': 'di', '主': 'zhu',
    '倍': 'bei'
  };
  var fileNames = {};
  MANIFESTS.forEach(function (t) {
    var p = '';
    for (var i = 0; i < t.length; i++) p += PINYIN[t[i]] || '';
    fileNames[t] = p + '.mp3';
  });

  /** 首次用户手势时批量预加载音频包。
   *  仅 http/https 走 fetch：file:// 下浏览器会把 fetch 按跨域一律拦截
   *  （origin 为 null），白发 107 个必败请求；file:// 由 HTMLAudio 兜底。 */
  function loadVoicePack() {
    if (packLoaded) return;
    packLoaded = true;
    if (typeof global.fetch !== 'function') return;
    var proto = global.location ? global.location.protocol : '';
    if (proto !== 'http:' && proto !== 'https:') return;
    var ac = getAudioContext();
    if (!ac) return;

    MANIFESTS.forEach(function (text) {
      if (audioBuffers[text]) return;
      fetch('js/voice/' + fileNames[text])
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
      .then(function (ab) { return ac.decodeAudioData(ab); })
      .then(function (buf) { audioBuffers[text] = buf; packReady = true; })
      .catch(function () { /* 缺文件静默忽略（播放时走元素兜底） */ });
    });
  }

  function getAudioContext() {
    return global.Sound && global.Sound.getRawContext ? global.Sound.getRawContext() : null;
  }

  /** 播放预录制音频，返回是否成功。
   *  两级通道：WebAudio buffer（http 预加载的主路径）→ HTMLAudio 兜底。 */
  function playPre(text, gender, excitement, cue) {
    var buf = audioBuffers[text];
    if (buf) {
      var ac = getAudioContext();
      if (ac && ac.state === 'running') {
        try {
          var src = ac.createBufferSource();
          src.buffer = buf;
          src.playbackRate.value = gender === 'male' ? 0.85 : (excitement ? 1.08 : 1.0);
          var gain = ac.createGain();
          gain.gain.value = excitement ? 0.9 : 0.72;
          src.connect(gain);
          gain.connect(ac.destination);
          src.start(0);
          return true;
        } catch (e) { /* 落入元素兜底 */ }
      }
    }
    return playViaAudioEl(text, gender, excitement, cue);
  }

  /** HTMLAudio 兜底：file:// 下 fetch 被浏览器按跨域拦截拿不到 AudioBuffer，
   *  但 <audio> 加载相对路径不受限。playbackRate 降速同时降调（0.85 男声
   *  变调 / 1.08 情绪加速），关掉 preservesPitch 的「保音高」才能复刻
   *  重采样的降调效果（老 Safari 只认 webkitPreservesPitch，双写）。 */
  function playViaAudioEl(text, gender, excitement, cue) {
    var fname = fileNames[text];
    if (!fname || typeof global.Audio !== 'function') { cueFor(cue); return true; }
    try {
      var a = new global.Audio('js/voice/' + fname);
      a.volume = excitement ? 0.9 : 0.72;
      a.playbackRate = gender === 'male' ? 0.85 : (excitement ? 1.08 : 1.0);
      a.preservesPitch = false;
      a.webkitPreservesPitch = false;
      var p = a.play();
      if (p && p.then) {
        p.then(function () { packReady = true; })
          .catch(function () { cueFor(cue); });   // 播放失败（缺文件等）→ 提示音兜底
      } else {
        packReady = true;
      }
      return true;
    } catch (e) { return false; }
  }

  /* ---- 语义音效层 ---- */

  function cueFor(cue) {
    var S = global.Sound;
    if (!S) return;
    S.play(cue || 'vPlay');
  }

  /* ---- 短语文本 ---- */

  var RANK_CN = ['', '', '', '三', '四', '五', '六', '七', '八', '九', '十',
    '钩', '圈', 'K', '尖', '二', '小王', '大王'];

  function comboText(combo) {
    var Cards = global.Cards;
    if (!combo || !Cards) return '';
    var CT = Cards.CT;
    // 播报文本即音频包查找键与文件名：直接输出无标点短语
    switch (combo.type) {
      case CT.ROCKET: return '王炸';
      case CT.BOMB: return '炸弹';
      case CT.SINGLE: return RANK_CN[combo.main];
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

  /* ---- 统一播报入口 ---- */

  function speak(text, gender, excitement, cue) {
    if (!enabled || !text) return;

    // Layer 0: 预录制音频（WebAudio buffer → HTMLAudio 兜底）
    if (playPre(text, gender, excitement, cue)) return;

    // Layer 1: 语义音效兜底
    cueFor(cue);
  }

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

  function announceBid(seat, score) {
    var texts = ['不叫', '一分', '两分', '三分'];
    speak(texts[score] || '', seatGender(seat), score === 3, 'bid');
  }

  function announceLandlord(seat) {
    speak('叫地主', seatGender(seat), true, 'vLandlord');
  }

  function announceDouble(seat, level) {
    var t = level === 2 ? '超级加倍' : (level === 1 ? '加倍' : '不加倍');
    speak(t, seatGender(seat), level > 0, 'double');
  }

  function setEnabled(v) {
    enabled = !!v;
  }
  function isEnabled() { return enabled; }

  function engineInfo() {
    return {
      engine: packReady ? 'pre' : 'sfx',
      preloaded: Object.keys(audioBuffers).length
    };
  }

  function engineText() {
    // packReady 表示任一通道（WebAudio 预加载 / HTMLAudio 兜底）真实出过声
    if (packReady) return '预录制语音包（107 条）';
    return '提示音（语音包未加载完成）';
  }

  global.Voice = {
    comboText: comboText,
    announcePlay: announcePlay,
    announcePass: announcePass,
    announceBid: announceBid,
    announceLandlord: announceLandlord,
    announceDouble: announceDouble,
    speak: function (text, gender, cue) { speak(text, gender || 'female', false, cue); },
    seatGender: seatGender,
    warmup: function () { loadVoicePack(); },
    engineInfo: engineInfo,
    engineText: engineText,
    setEnabled: setEnabled,
    isEnabled: isEnabled
  };

})(typeof window !== 'undefined' ? window : globalThis);
