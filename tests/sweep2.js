/* 斗地主 —— 纯前端单机斗地主游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* 跟牌阈值扫描：passBias 控制 AI 是「太怂」还是「太浪」 */
'use strict';
const { execFile } = require('child_process');
const path = require('path');
const node = process.execPath;

const N = process.env.SW_N || '200';
const SEED = process.env.SW_SEED || '555777';

const CONFIGS = [
  { label: 'passBias=-6 (更激进) ', feat: 'passBias:-6' },
  { label: 'passBias=0  (当前)   ', feat: 'passBias:0' },
  { label: 'passBias=+4 (更保守) ', feat: 'passBias:4' }
];

let pending = CONFIGS.length * 2;
const results = [];

function run(cfg, aSide, cb) {
  execFile(node, ['tests/duel.js', aSide, aSide === 'hard' ? 'normal' : 'hard', N, SEED], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { FEAT: cfg.feat }),
    maxBuffer: 1 << 20
  }, function (err, stdout) {
    let d = null;
    try { d = JSON.parse(stdout.trim().split('\n').pop()); } catch (e) { d = null; }
    cb(d);
  });
}

CONFIGS.forEach(function (cfg) {
  let hardSeat0 = null, normalSeat0 = null;
  function done() { if (--pending === 0) report(); }
  run(cfg, 'hard', function (d) { hardSeat0 = d; if (normalSeat0 !== null) { results.push({ cfg: cfg, hard: hardSeat0, normal: normalSeat0 }); } done(); });
  run(cfg, 'normal', function (d) { normalSeat0 = d; if (hardSeat0 !== null) { results.push({ cfg: cfg, hard: hardSeat0, normal: normalSeat0 }); } done(); });
});

function report() {
  console.log('=== 跟牌阈值扫描（' + N + ' 局固定牌局）===');
  console.log('配置                  hard做0号位   normal做0号位   强弱差');
  results.forEach(function (r) {
    if (!r.hard || !r.normal) { console.log('  ' + r.cfg.label + ' 数据缺失'); return; }
    const d = r.hard.diff - r.normal.diff;
    console.log('  ' + r.cfg.label + '   ' +
      String(r.hard.diff.toFixed(3)).padStart(8) + '        ' +
      String(r.normal.diff.toFixed(3)).padStart(8) + '      ' +
      String(d.toFixed(3)).padStart(8));
  });
}
