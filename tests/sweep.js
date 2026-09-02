/* 斗地主 —— 纯前端单机斗地主游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* 参数扫描：在固定牌局上对比不同残局推演阈值 / 采样数的强弱 */
'use strict';
const { execFile } = require('child_process');
const path = require('path');
const node = process.execPath;

const N = process.env.SW_N || '200';
const SEED = process.env.SW_SEED || '20260831';

// 每个配置跑一次「hard 在 0 号位」和一次「normal 在 0 号位」，
// 两者相减可抵消「0 号位本身的位置偏差」，得到更干净的强弱差。
const CONFIGS = [
  { label: '不推演(基线)      ', feat: 'forcedWin:1,rollout:0' },
  { label: '残局≤6            ', feat: 'forcedWin:1,rollout:1', endgame: '6' },
  { label: '残局≤9            ', feat: 'forcedWin:1,rollout:1', endgame: '9' },
  { label: '残局≤13           ', feat: 'forcedWin:1,rollout:1', endgame: '13' },
  { label: '残局≤17(全程)     ', feat: 'forcedWin:1,rollout:1,rolloutAlways:1', endgame: '17' }
];

let pending = CONFIGS.length * 2;
const results = [];

function run(cfg, aSide, cb) {
  const env = Object.assign({}, process.env, { FEAT: cfg.feat });
  if (cfg.endgame) env.ENDGAME = cfg.endgame;
  execFile(node, ['tests/duel.js', aSide, aSide === 'hard' ? 'normal' : 'hard', N, SEED], {
    cwd: path.join(__dirname, '..'), env, maxBuffer: 1 << 20
  }, function (err, stdout) {
    let d = null;
    try { d = JSON.parse(stdout.trim().split('\n').pop()); } catch (e) { d = null; }
    cb(d);
  });
}

CONFIGS.forEach(function (cfg) {
  let hardSeat0 = null, normalSeat0 = null;
  function done() {
    if (--pending === 0) report();
  }
  run(cfg, 'hard', function (d) {
    hardSeat0 = d;
    if (normalSeat0 !== null) {
      results.push({ cfg: cfg, hard: hardSeat0, normal: normalSeat0 });
    }
    done();
  });
  run(cfg, 'normal', function (d) {
    normalSeat0 = d;
    if (hardSeat0 !== null) {
      results.push({ cfg: cfg, hard: hardSeat0, normal: normalSeat0 });
    }
    done();
  });
});

function report() {
  console.log('=== 残局推演阈值扫描（' + N + ' 局固定牌局，种子 ' + SEED + '）===');
  console.log('配置                 hard做0号位   normal做0号位   强弱差(越大越好)');
  results.forEach(function (r) {
    if (!r.hard || !r.normal) {
      console.log('  ' + r.cfg.label + '  数据缺失');
      return;
    }
    // hard 在 0 号位的优势 − normal 在 0 号位的优势，抵消位置偏差
    const d = r.hard.diff - r.normal.diff;
    const pad = (v, n) => String(v).padStart(n);
    console.log('  ' + r.cfg.label + '   ' +
      pad(r.hard.diff.toFixed(3), 8) + '        ' +
      pad(r.normal.diff.toFixed(3), 8) + '      ' +
      pad(d.toFixed(3), 8));
  });
}
