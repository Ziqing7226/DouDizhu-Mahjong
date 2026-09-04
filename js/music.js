/* 斗地主 —— 纯前端单机斗地主游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * music.js —— 纯 WebAudio 合成的中式背景音乐（无任何外部音频文件）
 *
 * 方案（用户已确认）：原创五声音阶循环旋律；
 *   平时「轻快活泼」，局势紧张（有人快走完 / 倍数飙升）自动切换「紧张型」；
 *   顶栏独立开关 + 音量滑块，与音效开关分开，设置持久化。
 *
 * 实现：前向调度（lookahead scheduling）——
 *   定时器每 60ms 醒一次，把未来 0.3s 内的音符按 AudioContext 时钟精确排程。
 *   换情绪时在**小节边界**切换，避免旋律突兀断裂。
 * ========================================================================== */
(function (global) {
  'use strict';

  var Sound = global.Sound;

  /* ---------------- 音色 ---------------- */

  /** 拨弦（弹拨乐质感）：快攻速、指数衰减，中式五声音阶的主力音色 */
  function pluck(ac, out, freq, t0, dur, vol) {
    var osc = ac.createOscillator();
    var g = ac.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(vol * 0.28, t0 + Math.min(0.12, dur * 0.4));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(out);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }

  /** 笛声（长音）：正弦 + 颤音，用于乐句收尾的长音 */
  function flute(ac, out, freq, t0, dur, vol) {
    var osc = ac.createOscillator();
    var vib = ac.createOscillator();
    var vibG = ac.createGain();
    var g = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    vib.frequency.setValueAtTime(5.2, t0);
    vibG.gain.setValueAtTime(freq * 0.006, t0);
    vib.connect(vibG); vibG.connect(osc.frequency);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.05);
    g.gain.setValueAtTime(vol, t0 + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(out);
    osc.start(t0); vib.start(t0);
    osc.stop(t0 + dur + 0.02); vib.stop(t0 + dur + 0.02);
  }

  /** 低音：圆润的正弦 */
  function bassNote(ac, out, freq, t0, dur, vol) {
    var osc = ac.createOscillator();
    var g = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(out);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }

  /** 底鼓 */
  function kick(ac, out, noiseBuf, t0, vol) {
    var osc = ac.createOscillator();
    var g = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(130, t0);
    osc.frequency.exponentialRampToValueAtTime(45, t0 + 0.1);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.13);
    osc.connect(g); g.connect(out);
    osc.start(t0); osc.stop(t0 + 0.15);
  }

  /** 镲片（噪声过高通） */
  function hat(ac, out, noiseBuf, t0, vol, hp) {
    var src = ac.createBufferSource();
    var f = ac.createBiquadFilter();
    var g = ac.createGain();
    src.buffer = noiseBuf;
    f.type = 'highpass';
    f.frequency.setValueAtTime(hp || 7000, t0);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.045);
    src.connect(f); f.connect(g); g.connect(out);
    src.start(t0); src.stop(t0 + 0.06);
  }

  /** 军鼓类的紧张点缀 */
  function snare(ac, out, noiseBuf, t0, vol) {
    var src = ac.createBufferSource();
    var f = ac.createBiquadFilter();
    var g = ac.createGain();
    src.buffer = noiseBuf;
    f.type = 'bandpass';
    f.frequency.setValueAtTime(1900, t0);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1);
    src.connect(f); f.connect(g); g.connect(out);
    src.start(t0); src.stop(t0 + 0.12);
  }

  /* ---------------- 乐理数据 ---------------- */

  // C 宫五声音阶（宫商角徵羽）：C D E G A
  var CALM_SCALE = [261.63, 293.66, 329.63, 392.00, 440.00,
    523.25, 587.33, 659.26, 783.99, 880.00];
  // A 羽五声（小调色彩）：A C D E G
  var TENSE_SCALE = [220.00, 261.63, 293.66, 329.63, 392.00,
    440.00, 523.25, 587.33, 659.26, 783.99];

  // C2 A2 F2 G2 D2 E2 —— 低音声部用的根音
  var BASS = { C: 65.41, A: 110.00, F: 87.31, G: 98.00, D: 73.42, E: 82.41 };

  /**
   * 旋律记谱：[音阶下标, 时值(八分音符数)]，-1 表示休止。
   * 每小节 8 个八分音符，8 小节共 64 步一循环。
   */
  var CALM_BARS = [
    [[0, 1], [1, 1], [2, 2], [3, 1], [2, 1], [1, 2]],
    [[2, 1], [3, 1], [4, 2], [3, 1], [2, 1], [3, 2]],
    [[4, 1], [5, 1], [4, 2], [3, 1], [2, 1], [1, 2]],
    [[2, 2], [1, 1], [0, 1], [1, 2], [-1, 2]],
    [[5, 1], [6, 1], [7, 2], [6, 1], [5, 1], [6, 2]],
    [[7, 1], [8, 1], [7, 2], [6, 1], [5, 1], [4, 2]],
    [[3, 1], [4, 1], [5, 2], [4, 1], [3, 1], [2, 2]],
    [[1, 1], [2, 1], [1, 2], [0, 2], [-1, 2]]
  ];
  // 低音进行：C – Am – F – G ×2，每小节在第 1、3 拍落根音
  var CALM_BASS = ['C', 'A', 'F', 'G', 'C', 'A', 'F', 'G'];

  // 紧张型：同是五声框架，但更急、更低、节奏更碎
  var TENSE_BARS = [
    [[0, 1], [0, 1], [1, 1], [0, 1], [3, 2], [2, 1], [1, 1]],
    [[3, 1], [3, 1], [4, 1], [3, 1], [5, 2], [3, 1], [2, 1]],
    [[5, 1], [6, 1], [5, 1], [4, 1], [3, 2], [1, 2]],
    [[2, 1], [3, 1], [2, 1], [1, 1], [0, 2], [-1, 2]],
    [[5, 1], [5, 1], [6, 1], [7, 1], [8, 2], [7, 1], [6, 1]],
    [[8, 1], [9, 1], [8, 1], [7, 1], [6, 2], [5, 2]],
    [[4, 1], [5, 1], [4, 1], [3, 1], [2, 2], [3, 1], [2, 1]],
    [[1, 1], [2, 1], [0, 2], [0, 1], [-1, 3]]
  ];
  var TENSE_BASS = ['A', 'A', 'F', 'G', 'A', 'A', 'D', 'E'];

  /* ---------------- 展开为逐步事件表 ---------------- */

  /**
   * 把小节记谱展开成 events[step] = [指令...]，每小节 8 步。
   * 返回 { events, loopSteps, scale, bpm }
   */
  function buildPattern(bars, bassRoots, scale, bpm, tense) {
    var STEPS_PER_BAR = 8;
    var events = [];
    var step = 0;
    for (var b = 0; b < bars.length; b++) {
      var s0 = b * STEPS_PER_BAR;
      // 旋律
      var cur = s0;
      for (var n = 0; n < bars[b].length; n++) {
        var idx = bars[b][n][0], dur = bars[b][n][1];
        if (!events[cur]) events[cur] = [];
        if (idx >= 0) {
          events[cur].push({
            inst: (dur >= 2 && n === bars[b].length - 1) ? 'flute' : 'pluck',
            freq: scale[idx], dur: dur * (60 / bpm / 2) * 0.94, vol: 0.16
          });
        }
        cur += dur;
      }
      // 低音
      var root = BASS[bassRoots[b]];
      for (var bi = 0; bi < 8; bi += (tense ? 2 : 4)) {
        if (!events[s0 + bi]) events[s0 + bi] = [];
        events[s0 + bi].push({ inst: 'bass', freq: root, dur: (tense ? 0.22 : 0.4), vol: 0.13 });
      }
      // 打击乐
      for (var d = 0; d < 8; d += 2) {
        if (!events[s0 + d]) events[s0 + d] = [];
        if (tense) {
          events[s0 + d].push({ inst: (d === 0 || d === 4) ? 'kick' : 'hat', vol: d === 0 || d === 4 ? 0.2 : 0.05 });
          if (d === 2 || d === 6) events[s0 + d].push({ inst: 'snare', vol: 0.09 });
          if (d + 1 < 8) {
            if (!events[s0 + d + 1]) events[s0 + d + 1] = [];
            events[s0 + d + 1].push({ inst: 'hat', vol: 0.035 });
          }
        } else {
          events[s0 + d].push({ inst: d === 0 ? 'kick' : 'hat', vol: d === 0 ? 0.12 : 0.03 });
          // 反拍镲片：补齐空步并带来轻快的律动感
          if (d + 1 < 8) {
            if (!events[s0 + d + 1]) events[s0 + d + 1] = [];
            events[s0 + d + 1].push({ inst: 'hat', vol: 0.022 });
          }
        }
      }
      step += STEPS_PER_BAR;
    }
    return {
      events: events,
      loopSteps: bars.length * STEPS_PER_BAR,
      stepsPerBar: STEPS_PER_BAR,
      bpm: bpm
    };
  }

  var PATTERNS = {
    calm: buildPattern(CALM_BARS, CALM_BASS, CALM_SCALE, 112, false),
    tense: buildPattern(TENSE_BARS, TENSE_BASS, TENSE_SCALE, 132, true)
  };

  /* ---------------- 播放器 ---------------- */

  var ac = null, master = null, noiseBuf = null;
  var playing = false, timer = null;
  var mood = 'calm', pendingMood = null;
  var step = 0, nextTime = 0;
  var volume = 0.4;
  var enabled = true;

  var LOOKAHEAD = 0.3, TICK_MS = 60;

  function ensureContext() {
    if (ac) return true;
    var raw = Sound && Sound.getRawContext ? Sound.getRawContext() : null;
    if (!raw) return false;
    ac = raw;
    master = ac.createGain();
    master.gain.value = enabled ? volume : 0;
    master.connect(ac.destination);
    // 自建一份噪声缓冲，避免依赖音效模块内部状态
    var len = Math.floor(ac.sampleRate * 0.3);
    noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
    var data = noiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return true;
  }

  function playEvent(ev, t0) {
    var v = ev.vol === undefined ? 0.1 : ev.vol;
    switch (ev.inst) {
      case 'pluck': pluck(ac, master, ev.freq, t0, ev.dur, v); break;
      case 'flute': flute(ac, master, ev.freq, t0, ev.dur, v * 0.9); break;
      case 'bass': bassNote(ac, master, ev.freq, t0, ev.dur, v); break;
      case 'kick': kick(ac, master, noiseBuf, t0, v); break;
      case 'hat': hat(ac, master, noiseBuf, t0, v); break;
      case 'snare': snare(ac, master, noiseBuf, t0, v); break;
    }
  }

  function tick() {
    if (!playing || !ac) return;
    // iOS 上 TTS 抢占音频会话会让上下文进入 interrupted —— 每次调度顺手
    // 尝试唤醒，恢复不了就跳过本轮（等下一次 tick），绝不在坏状态里排音符
    if (ac.state !== 'running') {
      try { ac.resume(); } catch (e) { /* 忽略 */ }
      if (ac.state !== 'running') return;
    }
    var pat = PATTERNS[mood];
    var stepDur = 60 / pat.bpm / 2;
    var now = ac.currentTime;
    // 音频上下文被系统挂起又恢复（如调整音量、锁屏）后，调度时钟可能已落后
    // 现实很多 —— 重同步到当下，而不是把一堆「过去」的音符瞬间全部触发
    // （那会造成节点风暴与卡顿，且状态会一直坏到刷新页面为止）。
    if (nextTime < now - 0.25) {
      nextTime = now + 0.05;
      step = Math.round(step / pat.stepsPerBar) * pat.stepsPerBar;   // 对齐小节，旋律不突兀
    }
    while (nextTime < now + LOOKAHEAD) {
      var evs = pat.events[step % pat.loopSteps];
      if (evs) for (var i = 0; i < evs.length; i++) playEvent(evs[i], nextTime);
      // 小节边界处应用待切换的情绪，让旋律在乐句收尾时自然转换
      if (pendingMood && (step + 1) % pat.stepsPerBar === 0) {
        mood = pendingMood;
        pendingMood = null;
      }
      step++;
      nextTime += 60 / PATTERNS[mood].bpm / 2;
    }
  }

  function start() {
    if (!enabled) return;
    if (!ensureContext()) return;      // 音频上下文还没就绪（需用户先交互）
    if (ac.state === 'suspended') ac.resume();
    if (playing) return;
    playing = true;
    step = 0;
    nextTime = ac.currentTime + 0.1;
    timer = setInterval(tick, TICK_MS);
  }

  function stop() {
    playing = false;
    if (timer) { clearInterval(timer); timer = null; }
  }

  /* ---------------- 对外接口 ---------------- */

  function setEnabled(v) {
    enabled = !!v;
    if (!enabled) { stop(); return; }
    if (playing) return;
    start();
  }

  function setVolume(v) {
    volume = Math.max(0, Math.min(1, Number(v) || 0));
    if (master) master.gain.value = enabled ? volume : 0;
  }

  /** 切换情绪：calm（轻快）/ tense（紧张），在小节边界生效 */
  function setMood(m) {
    if (!PATTERNS[m]) return;
    if (m === mood) return;
    if (!playing) { mood = m; return; }
    pendingMood = m;   // 等当前小节播完
  }

  function isPlaying() { return playing; }
  function isEnabled() { return enabled; }
  function getVolume() { return volume; }
  function getMood() { return mood; }

  global.Bgm = {
    start: start,
    stop: stop,
    setEnabled: setEnabled,
    setVolume: setVolume,
    setMood: setMood,
    isPlaying: isPlaying,
    isEnabled: isEnabled,
    getVolume: getVolume,
    getMood: getMood,
    /* 供测试与调试：手动驱动一次调度 */
    _tick: tick,
    _patterns: PATTERNS
  };

})(typeof window !== 'undefined' ? window : globalThis);
