/* 斗地主 —— 纯前端单机斗地主游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* 最终冒烟：一次跑完两套回归测试，输出汇总，便于交付前一键确认 */
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const node = process.execPath;

const root = path.join(__dirname, '..');
const runs = [
  { name: '核心逻辑（默认样本）', args: ['tests/test-core.js'] },
  { name: '端到端（8 局完整对局）', args: ['tests/test-ui.js'], env: { GAMES: '8' } }
];

let allOk = true;
for (const r of runs) {
  console.log('\n########## ' + r.name + ' ##########');
  try {
    const out = execFileSync(node, r.args, {
      cwd: root,
      env: Object.assign({}, process.env, r.env || {}),
      encoding: 'utf8',
      maxBuffer: 1 << 22,
      timeout: 300000
    });
    const lines = out.trim().split('\n');
    console.log(lines.slice(-6).join('\n'));
    if (!out.includes('全部通过')) allOk = false;
  } catch (e) {
    allOk = false;
    console.log('运行失败: ' + String(e.message).slice(0, 300));
  }
}

console.log('\n=========================================');
console.log(allOk ? '最终冒烟：全部通过 ✅' : '最终冒烟：存在失败 ❌');
process.exit(allOk ? 0 : 1);
