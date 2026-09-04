/* 斗地主 —— 纯前端单机斗地主游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * audio.js —— 用 WebAudio 实时合成音效，不依赖任何外部音频文件
 * 浏览器要求用户交互后才能启动音频上下文，故首次点击时再初始化。
 * ========================================================================== */
(function (global) {
  'use strict';

  var ctx = null;
  var master = null;
  var enabled = true;
  var noiseBuf = null;

  function init() {
    if (ctx) return ctx;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    // 预生成一段白噪声，炸弹/洗牌音效复用
    var len = Math.floor(ctx.sampleRate * 0.7);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = noiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    // iOS：TTS 播报会抢占音频会话，WebAudio 进入 interrupted 且不自愈 ——
    // 监听状态变化自动尝试恢复（'suspended' 属自动播放策略，交给手势兜底）
    if (ctx.addEventListener) {
      ctx.addEventListener('statechange', function () {
        if (ctx.state === 'interrupted') {
          try {
            var p = ctx.resume();
            if (p && p.catch) p.catch(function () { /* 失败则由下一次触摸兜底 */ });
          } catch (e) { /* 忽略 */ }
        }
      });
    }
    return ctx;
  }

  /** iOS / iPadOS 需要「在手势内播放一次真实声源」才算真正解锁：
   *  仅 resume() 在部分版本上不够。播放一段 50ms 静音 buffer 完成解锁。 */
  var unlocked = false;
  function unlockWithSilence() {
    if (unlocked || !ctx) return;
    try {
      var src = ctx.createBufferSource();
      var buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.05), ctx.sampleRate);
      src.buffer = buf;   // 全零 = 静音
      src.connect(ctx.destination);
      src.start(0);
      src.stop(ctx.currentTime + 0.06);   // 显式收尾，维持「每个音源都 stop」的配平约定
      unlocked = true;
    } catch (e) { /* 忽略 */ }
  }

  function resume() {
    init();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      try {
        var p = ctx.resume();
        if (p && p.then) p.then(unlockWithSilence, function () { });
      } catch (e) { /* 忽略 */ }
    }
    unlockWithSilence();
  }

  // 回到前台 / 任意触摸都尝试恢复（iOS 锁屏后会重新挂起上下文）
  if (global.document && global.document.addEventListener) {
    global.document.addEventListener('visibilitychange', function () {
      if (!global.document.hidden) resume();
    });
  }

  function setEnabled(v) {
    enabled = !!v;
    if (master) master.gain.value = enabled ? 0.5 : 0;
  }
  function isEnabled() { return enabled; }

  function now() { return ctx.currentTime; }

  /** 单个振荡器音符 */
  function tone(opt) {
    if (!enabled || !init()) return;
    var t0 = now() + (opt.delay || 0);
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = opt.type || 'sine';
    osc.frequency.setValueAtTime(opt.freq, t0);
    if (opt.to && opt.to !== opt.freq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, opt.to), t0 + opt.dur);
    }
    var vol = opt.vol === undefined ? 0.22 : opt.vol;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + Math.min(0.02, opt.dur * 0.3));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + opt.dur);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + opt.dur + 0.02);
  }

  /** 噪声簇（用于洗牌、爆炸） */
  function noise(opt) {
    if (!enabled || !init()) return;
    var t0 = now() + (opt.delay || 0);
    var src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    var filter = ctx.createBiquadFilter();
    filter.type = opt.filter || 'lowpass';
    filter.frequency.setValueAtTime(opt.freq || 1200, t0);
    if (opt.to) filter.frequency.exponentialRampToValueAtTime(Math.max(60, opt.to), t0 + opt.dur);
    var gain = ctx.createGain();
    var vol = opt.vol === undefined ? 0.25 : opt.vol;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + opt.dur);
    src.connect(filter); filter.connect(gain); gain.connect(master);
    src.start(t0);
    src.stop(t0 + opt.dur + 0.02);
  }

  /** 一段和弦 */
  function chord(freqs, opt) {
    for (var i = 0; i < freqs.length; i++) {
      tone({
        freq: freqs[i],
        dur: (opt && opt.dur) || 0.25,
        vol: (opt && opt.vol) || 0.16,
        type: (opt && opt.type) || 'triangle',
        delay: (opt && opt.delay || 0) + i * ((opt && opt.stagger) || 0)
      });
    }
  }

  var S = {
    /** 发牌：清脆的 "嗒" */
    deal: function () {
      noise({ freq: 3000, to: 800, dur: 0.06, vol: 0.14, filter: 'highpass' });
    },
    /** 选中卡牌 */
    select: function () {
      tone({ freq: 660, to: 880, dur: 0.06, vol: 0.12, type: 'square' });
    },
    /** 取消选中 */
    deselect: function () {
      tone({ freq: 440, to: 300, dur: 0.06, vol: 0.10, type: 'square' });
    },
    /** 出牌：纸张划过 */
    play: function () {
      noise({ freq: 2600, to: 500, dur: 0.13, vol: 0.18, filter: 'bandpass' });
      tone({ freq: 520, to: 300, dur: 0.1, vol: 0.08, type: 'triangle' });
    },
    /** 不要 */
    pass: function () {
      tone({ freq: 300, to: 190, dur: 0.16, vol: 0.13, type: 'sawtooth' });
    },
    /** 炸弹 */
    bomb: function () {
      noise({ freq: 900, to: 60, dur: 0.55, vol: 0.42 });
      tone({ freq: 130, to: 34, dur: 0.6, vol: 0.34, type: 'sawtooth' });
      tone({ freq: 70, to: 26, dur: 0.75, vol: 0.28, type: 'sine', delay: 0.03 });
    },
    /** 王炸：两声雷 */
    rocket: function () {
      noise({ freq: 1400, to: 40, dur: 0.75, vol: 0.45 });
      tone({ freq: 180, to: 30, dur: 0.8, vol: 0.32, type: 'sawtooth' });
      tone({ freq: 90, to: 24, dur: 0.9, vol: 0.3, type: 'sine', delay: 0.12 });
      tone({ freq: 1200, to: 200, dur: 0.3, vol: 0.14, type: 'square', delay: 0.05 });
    },
    /** 叫分提示 */
    bid: function (n) {
      var base = [0, 523, 587, 659][n] || 523;
      tone({ freq: base, dur: 0.18, vol: 0.16, type: 'triangle' });
      tone({ freq: base * 1.5, dur: 0.22, vol: 0.1, type: 'sine', delay: 0.06 });
    },
    /** 加倍 */
    double: function () {
      chord([523, 659, 784], { dur: 0.3, stagger: 0.05, vol: 0.15 });
    },
    /** 春天 */
    spring: function () {
      chord([659, 784, 988, 1319], { dur: 0.5, stagger: 0.09, vol: 0.17 });
    },
    /** 胜利 */
    win: function () {
      var seq = [523, 659, 784, 1047];
      for (var i = 0; i < seq.length; i++) {
        tone({ freq: seq[i], dur: 0.34, vol: 0.2, type: 'triangle', delay: i * 0.13 });
      }
      chord([523, 659, 784, 1047], { dur: 0.9, delay: 0.55, vol: 0.13 });
    },
    /** 失败 */
    lose: function () {
      var seq = [494, 415, 349, 262];
      for (var i = 0; i < seq.length; i++) {
        tone({ freq: seq[i], dur: 0.4, vol: 0.19, type: 'sawtooth', delay: i * 0.16 });
      }
    },
    /** 轮到你的提醒 */
    turn: function () {
      tone({ freq: 880, dur: 0.12, vol: 0.13, type: 'sine' });
      tone({ freq: 1175, dur: 0.16, vol: 0.11, type: 'sine', delay: 0.11 });
    },
    /** 倒计时紧迫 */
    warn: function () {
      tone({ freq: 1000, to: 700, dur: 0.12, vol: 0.14, type: 'square' });
    },

    /* ------ 语音播报第三层兜底：语义辨识音（无 TTS 引擎时替代人声） ------ */
    /** 通用出牌 */
    vPlay: function () {
      noise({ freq: 2600, to: 500, dur: 0.12, vol: 0.16, filter: 'bandpass' });
    },
    /** 单张：一声轻快 */
    vSingle: function () {
      tone({ freq: 740, to: 980, dur: 0.09, vol: 0.16, type: 'triangle' });
    },
    /** 对子：双击 */
    vPair: function () {
      tone({ freq: 660, dur: 0.07, vol: 0.15, type: 'triangle' });
      tone({ freq: 880, dur: 0.09, vol: 0.15, type: 'triangle', delay: 0.08 });
    },
    /** 三张 / 三带：三连升 */
    vTriple: function () {
      var f = [600, 760, 940];
      for (var i = 0; i < 3; i++) tone({ freq: f[i], dur: 0.08, vol: 0.15, type: 'triangle', delay: i * 0.075 });
    },
    /** 顺子 / 连对 / 飞机：快速琶音 */
    vStraight: function () {
      var f = [520, 620, 740, 880, 1040];
      for (var i = 0; i < 5; i++) tone({ freq: f[i], dur: 0.07, vol: 0.13, type: 'triangle', delay: i * 0.055 });
    },
    /** 叫地主：小号角 */
    vLandlord: function () {
      var f = [523, 659, 784];
      for (var i = 0; i < 3; i++) tone({ freq: f[i], dur: 0.16, vol: 0.17, type: 'square', delay: i * 0.1 });
    },
    /** 麻将胡牌：锣声 + 欢庆 */
    vHu: function () {
      tone({ freq: 196, to: 185, dur: 1.1, vol: 0.3, type: 'sine' });
      tone({ freq: 392, to: 370, dur: 0.9, vol: 0.14, type: 'triangle' });
      chord([784, 988, 1175], { dur: 0.5, delay: 0.25, stagger: 0.07, vol: 0.15 });
    },
    /** 麻将杠：两记闷响 */
    vGang: function () {
      tone({ freq: 150, to: 70, dur: 0.22, vol: 0.3, type: 'sawtooth' });
      tone({ freq: 120, to: 55, dur: 0.3, vol: 0.3, type: 'sine', delay: 0.16 });
    },
    /** 麻将碰/吃：清脆叮咚 */
    vClaim: function () {
      tone({ freq: 880, dur: 0.08, vol: 0.16, type: 'sine' });
      tone({ freq: 660, dur: 0.12, vol: 0.16, type: 'sine', delay: 0.09 });
    }
  };

  function play(name, arg) {
    if (!enabled) return;
    resume();
    var f = S[name];
    if (f) { try { f(arg); } catch (e) { /* 音频异常不影响游戏 */ } }
  }

  /** 暴露原始 AudioContext，供背景音乐模块复用同一个上下文（省资源） */
  function getRawContext() { return init() ? ctx : null; }

  global.Sound = {
    init: init,
    resume: resume,
    play: play,
    setEnabled: setEnabled,
    isEnabled: isEnabled,
    getRawContext: getRawContext
  };

})(typeof window !== 'undefined' ? window : globalThis);
