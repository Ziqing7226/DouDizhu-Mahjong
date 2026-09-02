/* 斗地主 —— 纯前端单机斗地主游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* A/B 实验编排：并行跑多个特性组合，定位真正有效的机制 */
'use strict';
const { execFile } = require('child_process');
const path = require('path');
const node = process.execPath;

const N = process.env.AB_N || '150';
const VARIANTS = [
  {
    name: '旧困难(无推演)',
    feat: 'forcedWin:1,safeBonus:0,escapeBlock:0,mustBlock:0,holdsLead:0,rollout:0'
  },
  {
    name: '纯推演(关其他)  ',
    feat: 'forcedWin:1,safeBonus:0,escapeBlock:0,mustBlock:0,holdsLead:0,rollout:1'
  },
  {
    name: '推演+启发式全开  ',
    feat: 'forcedWin:1,safeBonus:1,escapeBlock:1,mustBlock:1,holdsLead:1,rollout:1'
  }
];

let pending = VARIANTS.length;
const results = [];

VARIANTS.forEach(function (v) {
  execFile(node, ['tests/bench-ai.js', N], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { FEAT: v.feat }),
    maxBuffer: 1 << 20
  }, function (err, stdout) {
    if (err) {
      results.push({ name: v.name, err: String(err).slice(0, 160) });
    } else {
      const grab = (name) => {
        const m = stdout.match(new RegExp(name + '\\s+(-?\\d+)\\s+(-?\\d*\\.\\d+)'));
        return m ? { total: parseInt(m[1]), per: parseFloat(m[2]) } : null;
      };
      const gap = stdout.match(/困难 - 简单 = (-?\d+)/);
      results.push({
        name: v.name,
        easy: grab('easy'), normal: grab('normal'), hard: grab('hard'),
        gap: gap ? gap[1] : '?'
      });
    }
    if (--pending === 0) report();
  });
});

function report() {
  console.log('=== A/B 实验（每组合 ' + N + ' 局）===');
  console.log('组合                hard场均   normal场均   hard−normal   hard−easy');
  results.forEach(function (r) {
    if (r.err) { console.log('  ' + r.name + ' 出错: ' + r.err); return; }
    const pad = (s, n) => String(s).padStart(n);
    console.log('  ' + r.name + '  ' + pad(r.hard.per.toFixed(3), 7) +
      '   ' + pad(r.normal.per.toFixed(3), 8) +
      '   ' + pad((r.hard.per - r.normal.per).toFixed(3), 10) +
      '   ' + pad(r.gap, 8));
  });
  console.log('\n（hard−normal > 0 说明困难档确实强过中等档）');
}
