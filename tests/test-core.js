/* 斗地主 —— 纯前端单机斗地主游戏
 * Copyright (C) 2026 Ziqing7226
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序为自由软件：你可以在 GNU 通用公共许可证第 3 版（或按你的选择，
 * 任何更高版本，由自由软件基金会发布）条款下重新分发和/或修改它。
 * 许可证全文见仓库根目录的 LICENSE 文件。
 */

/* ==========================================================================
 * test-core.js —— 牌型引擎 / 拆解器 / AI 的回归测试
 * 运行： node tests/test-core.js
 * ========================================================================== */
'use strict';

const Cards = require('../js/cards.js');
const FULL = process.argv.includes('--full');
const SMOKE_N = FULL ? 300 : 60;
const GAME_N  = FULL ? 200 : 60;
const Dec = require('../js/decompose.js');
const AI = require('../js/ai.js');
const CT = Cards.CT;

let pass = 0, fail = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; failures.push(msg); }
}
function eq(a, b, msg) {
  const good = JSON.stringify(a) === JSON.stringify(b);
  if (good) pass++;
  else { fail++; failures.push(`${msg}\n    期望 ${JSON.stringify(b)}\n    实际 ${JSON.stringify(a)}`); }
}

/* ---------------- 构造手牌 ---------------- */
const RANK_MAP = {
  '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
  'J': 11, 'Q': 12, 'K': 13, 'A': 14, '2': 15, 'w': 16, 'W': 17,
  '小王': 16, '大王': 17
};
let UID = 1000;
function H(str) {
  return str.split(/\s+/).filter(Boolean).map(t => {
    const r = RANK_MAP[t];
    if (r === undefined) throw new Error('未知牌面: ' + t);
    return { id: UID++, rank: r, suit: r >= 16 ? -1 : 0, joker: r >= 16, sym: '', red: false, label: t };
  });
}
function typeOf(str) {
  const c = Cards.parse(H(str));
  return c ? c.type : null;
}
function comboOf(str) {
  const c = Cards.parse(H(str));
  return c ? { t: c.type, main: c.main, len: c.len } : null;
}

console.log('=== 牌型识别 ===');

// 单 / 对 / 三
eq(typeOf('5'), CT.SINGLE, '单张 5');
eq(typeOf('W'), CT.SINGLE, '单张 大王');
eq(typeOf('5 5'), CT.PAIR, '对 5');
eq(typeOf('2 2'), CT.PAIR, '对 2');
eq(typeOf('7 7 7'), CT.TRIPLE, '三张 7');

// 王炸 / 炸弹
eq(typeOf('w W'), CT.ROCKET, '王炸');
eq(typeOf('9 9 9 9'), CT.BOMB, '炸弹 9');
eq(typeOf('2 2 2 2'), CT.BOMB, '炸弹 2');
eq(typeOf('w w'), null, '两张小王不合法');
eq(typeOf('W W'), null, '两张大王不合法');

// 三带
eq(typeOf('7 7 7 5'), CT.TRIPLE_ONE, '三带一');
eq(typeOf('7 7 7 W'), CT.TRIPLE_ONE, '三带一（带大王）');
eq(typeOf('7 7 7 5 5'), CT.TRIPLE_PAIR, '三带二');
eq(typeOf('7 7 7 5 6'), null, '三带两张散牌不合法');
eq(typeOf('7 7 8 8'), null, '两对不构成牌型');

// 顺子
eq(comboOf('3 4 5 6 7'), { t: CT.STRAIGHT, main: 7, len: 5 }, '顺子 34567');
eq(comboOf('10 J Q K A'), { t: CT.STRAIGHT, main: 14, len: 5 }, '顺子 10JQKA');
eq(typeOf('3 4 5 6'), null, '四张连牌不是顺子');
eq(typeOf('J Q K A 2'), null, '顺子不能含 2');
eq(typeOf('A 2 3 4 5'), null, 'A2345 不是顺子');
eq(typeOf('3 4 5 6 6 7'), null, '含对子的连牌不是顺子');
eq(comboOf('3 4 5 6 7 8 9 10 J Q K A'), { t: CT.STRAIGHT, main: 14, len: 12 }, '十二连顺');

// 连对
eq(comboOf('3 3 4 4 5 5'), { t: CT.DOUBLE_STRAIGHT, main: 5, len: 3 }, '连对 334455');
eq(typeOf('3 3 4 4'), null, '两连对不合法');
eq(typeOf('K K A A 2 2'), null, '连对不能含 2');
eq(typeOf('3 3 4 4 5 5 5 5'), CT.FOUR_TWO_PAIR, '5555+33+44 应识别为四带两对');

// 飞机
eq(comboOf('7 7 7 8 8 8'), { t: CT.TRIPLE_STRAIGHT, main: 8, len: 2 }, '飞机 777888');
eq(comboOf('7 7 7 8 8 8 9 9 9'), { t: CT.TRIPLE_STRAIGHT, main: 9, len: 3 }, '三连飞机');
eq(comboOf('7 7 7 8 8 8 3 9'), { t: CT.AIRPLANE_ONE, main: 8, len: 2 }, '飞机带两单');
eq(comboOf('7 7 7 8 8 8 3 3 9 9'), { t: CT.AIRPLANE_PAIR, main: 8, len: 2 }, '飞机带两对');
eq(comboOf('3 3 3 4 4 4 5 5 5 6 6 6'), { t: CT.TRIPLE_STRAIGHT, main: 6, len: 4 },
  '333444555666 应识别为四连飞机而非飞机带三单');
eq(typeOf('7 7 7 8 8 8 3'), null, '飞机带一张不合法');
eq(typeOf('A A A 2 2 2'), null, '飞机不能含 2');
eq(typeOf('7 7 7 8 8 8 9 9 9 9'), null, '333 类翅膀不能拆炸弹');

// 四带二
eq(comboOf('9 9 9 9 3 4'), { t: CT.FOUR_TWO, main: 9, len: 1 }, '四带二');
eq(comboOf('9 9 9 9 3 3'), { t: CT.FOUR_TWO, main: 9, len: 1 }, '四带一对');
eq(comboOf('9 9 9 9 3 3 4 4'), { t: CT.FOUR_TWO_PAIR, main: 9, len: 1 }, '四带两对');
eq(typeOf('9 9 9 9 3 3 3 3'), null, '两个四条不能组成四带两对');
eq(typeOf('9 9 9 9 3'), null, '四带一不合法');

console.log('=== 大小比较 ===');

const beat = (a, b) => Cards.canBeat(Cards.parse(H(a)), Cards.parse(H(b)));
ok(beat('6', '5'), '单张 6 压 5');
ok(!beat('5', '6'), '单张 5 压不过 6');
ok(beat('2', 'A'), '2 压 A');
ok(beat('w', '2'), '小王压 2');
ok(beat('W', 'w'), '大王压小王');
ok(beat('9 9 9 9', 'A'), '炸弹压单张 A');
ok(beat('w W', '9 9 9 9'), '王炸压炸弹');
ok(beat('2 2 2 2', 'A A A A'), '炸弹比点数');
ok(!beat('A A A A', '2 2 2 2'), '小炸弹压不过大炸弹');
ok(beat('4 5 6 7 8', '3 4 5 6 7'), '同长度顺子比大小');
ok(!beat('4 5 6 7 8 9', '3 4 5 6 7'), '长度不同的顺子不能压');
ok(beat('8 8 8 9 9 9', '7 7 7 8 8 8'), '飞机比大小');
ok(!beat('7 7 7 3 4', '5 5 5 6 6'), '牌型不同不能压');
ok(beat('7 7 7 3', '6 6 6 9'), '三带一比三张点数');

console.log('=== 压制组合枚举 ===');

function beatsOf(handStr, targetStr) {
  const res = Cards.findBeats(H(handStr), Cards.parse(H(targetStr)));
  return res.map(cs => cs.map(c => c.label).join(''));
}
let r1 = beatsOf('3 4 5 6 7 8 9', '5');
ok(r1.length >= 4, '手牌 3-9 压单张 5 应有多个选择，实际 ' + r1.length);

let r2 = beatsOf('3 3 4 4 5 5 6 6', '3 3 4 4 5 5');
ok(r2.some(x => x === '445566'), '应能找到 445566 压 334455，实际 ' + JSON.stringify(r2));

let r3 = beatsOf('7 7 7 8 8 8 9 9 9 3 4', '3 3 3 4 4 4 5 6');
ok(r3.length >= 1, '应能找到更大的飞机带单，实际 ' + JSON.stringify(r3));

let r4 = beatsOf('9 9 9 9 3 4 5', '8 8 8 8 6 7');
ok(r4.length >= 1, '炸弹压四带二，实际 ' + JSON.stringify(r4));

let r5 = beatsOf('3 4 5', 'Q');
eq(r5, [], '压不过就该没有候选');

let r6 = beatsOf('w W 3', '2 2 2 2');
ok(r6.some(x => x === 'wW'), '王炸应作为候选出现，实际 ' + JSON.stringify(r6));

console.log('=== 手牌拆解 ===');

const d1 = Dec.decompose(H('3 4 5 6 7 8 8'));
eq(d1.count, 2, '34567 + 88 应拆为 2 手，实际 ' + d1.count);

const d2 = Dec.decompose(H('3 3 3 4 4 4 5 6'));
ok(d2.count <= 2, '333444 56 应能拆成 2 手（飞机带两单），实际 ' + d2.count);

const d3 = Dec.decompose(H('3 4 5 6 7 8 9 10'));
eq(d3.count, 1, '3-10 八连顺应为 1 手，实际 ' + d3.count);

const d4 = Dec.decompose(H('3 5 7 9 J K A 2 w W'));
eq(d4.count, 9, '8 张散牌 + 王炸应为 9 手，实际 ' + d4.count);

const d5 = Dec.decompose(H('3 3 4 4 5 5 6 6 7 7'));
eq(d5.count, 1, '3344556677 五连对应为 1 手，实际 ' + d5.count);

// 拆解结果必须是合法牌型且牌数守恒
function checkDecompose(str) {
  const hand = H(str);
  const d = Dec.decompose(hand);
  let total = 0;
  for (const h of d.hands) {
    total += h.length;
    if (!Cards.parse(h)) return `拆解出非法牌型: ${h.map(c => c.label).join(' ')}`;
  }
  if (total !== hand.length) return `牌数不守恒: ${total} != ${hand.length}`;
  return null;
}
const samples = [
  '3 4 5 6 7 8 9 10 J',
  '3 3 3 4 4 4 5 5 5 6 6 6 7 7 8 8 9 9',
  '3 5 7 9 J K A 2 w W 4 6',
  'A A A A K K K K Q Q J J 10 10 9',
  '3 3 3 3 4 4 4 4 5 5 5 5 6 6 6 6 7 7',
  '2 2 2 2 w W A A A K K K Q Q Q J J'
];
for (const s of samples) {
  const err = checkDecompose(s);
  ok(!err, `拆解校验 [${s}] ${err || ''}`);
}

console.log('=== 记牌与绝张判定 ===');

const myHand = H('3 4 5 6 7');
const played = H('8 8 8 8 9 9 9 9 10 10 10 10 J J J J Q Q Q Q K K K K A A A A 2 2 2 2 w W');
const unseen = AI.unseenCounts(myHand, played);
eq(unseen[15], 0, '四张 2 都已出现，未出现应为 0');
ok(AI.isBoss(Cards.parse(H('A')), unseen), '2 和王都已出完，A 是绝张');
ok(AI.isBoss(Cards.parse(H('7')), unseen), '5-7 中 7 应为绝张（8 以上全出完）');
ok(AI.isBoss(Cards.parse(H('3 4 5 6 7')), unseen), '该顺子应为绝张');

console.log('=== AI 决策冒烟 ===');

function aiCtx(hand, lastCombo, opts) {
  opts = opts || {};
  return Object.assign({
    difficulty: 'hard',
    hand: hand,
    seat: 1,
    role: 'farmer',
    landlordSeat: 0,
    teammateSeat: 2,
    lastCombo: lastCombo || null,
    lastSeat: lastCombo ? 0 : undefined,
    counts: [10, hand.length, 7],
    played: []
  }, opts);
}

// 构造三家真实手牌（座位 1 是被测方，另两家分别 10 / 7 张，与 aiCtx 的 counts 一致）
function buildHands(myHand) {
  const used = new Set(myHand.map(c => c.id));
  const rest = Cards.makeDeck().filter(c => !used.has(c.id));
  return [rest.slice(0, 10), myHand, rest.slice(10, 17)];
}

// AI 出的每一手都必须合法，且确实大过上家
function checkAI(diff, handStr, targetStr) {
  const hand = H(handStr);
  const target = targetStr ? Cards.parse(H(targetStr)) : null;
  const res = AI.decidePlay(aiCtx(hand, target, {
    difficulty: diff,
    // 大师档只有同时满足 CFG.perfectInfo 且调用方传入真实手牌时才走完全信息路径
    // （见 ai.js decidePlay: ctx.perfectInfo = !!cfg.perfectInfo && !!ctx.hands），
    // 不传 hands 就测不到它真实使用的那条分支
    hands: diff === 'master' ? buildHands(hand) : null
  }));
  if (!res) return null;
  const combo = Cards.parse(res.cards);
  if (!combo) return `AI 给出了非法牌型: ${res.cards.map(c => c.label).join(' ')}`;
  // 出的牌必须都在手里
  const ids = new Set(hand.map(c => c.id));
  for (const c of res.cards) if (!ids.has(c.id)) return 'AI 出了手里没有的牌';
  if (target && !Cards.canBeat(combo, target)) return 'AI 出的牌压不过上家';
  return null;
}

const diffs = ['easy', 'normal', 'hard', 'master'];
let aiChecks = 0;
for (const d of diffs) {
  for (let i = 0; i < SMOKE_N; i++) {
    const deck = Cards.shuffle(Cards.makeDeck());
    const hand = deck.slice(0, 17);
    const err1 = checkAI(d, hand.map(c => c.label).join(' '));
    ok(!err1, `[${d}] 自由出牌: ${err1 || ''}`);
    aiChecks++;

    // 随机构造一个上家的牌型
    const targets = ['5', '9 9', 'K K K 3', '3 4 5 6 7', '5 5 6 6 7 7',
      '7 7 7 8 8 8 3 4', 'A A A A 3 4', 'Q', '10 10 10 4 4'];
    const t = targets[i % targets.length];
    const err2 = checkAI(d, hand.map(c => c.label).join(' '), t);
    ok(!err2, `[${d}] 跟牌 ${t}: ${err2 || ''}`);
    aiChecks++;
  }
}
console.log(`  （共执行 ${aiChecks} 次 AI 决策校验）`);

// 叫分
for (const d of diffs) {
  const strong = H('W w 2 2 2 A A A K K K Q Q J');
  // 真正的弱牌：无大牌、无炸弹、要拆成 7 手，bidScore ≈ 0.85，远低于 6.5 的阈值
  const weak = H('3 3 4 4 6 6 8 8 10 10 Q Q 5 7 9 J K');
  ok(AI.decideBid(strong, { difficulty: d }) >= 2, `[${d}] 强牌应至少叫 2 分`);
  ok(AI.decideBid(weak, { difficulty: d }) === 0, `[${d}] 弱牌应不叫`);
}
ok(AI.bidScore(H('3 3 4 4 6 6 8 8 10 10 Q Q 5 7 9 J K')) < 6.5,
  '弱牌样例的强度分应低于叫分阈值');

// 拆解缓存回归：点数分布相同、但属于不同人的两手牌，
// 拆解结果必须各自取自自己的手牌，否则 AI 会「打出」别人的牌导致手牌永不减少
{
  const a = H('3 3 4 5 6 7 8 9 10 J Q K A A 2 2 w');
  const b = H('3 3 4 5 6 7 8 9 10 J Q K A A 2 2 w');
  const idsA = new Set(a.map(c => c.id));
  const idsB = new Set(b.map(c => c.id));
  let leak = 0;
  Dec.decompose(a).hands.forEach(h => h.forEach(c => { if (!idsA.has(c.id)) leak++; }));
  Dec.decompose(b).hands.forEach(h => h.forEach(c => { if (!idsB.has(c.id)) leak++; }));
  ok(leak === 0, `拆解结果里出现了不属于自己的牌（${leak} 张），缓存可能串了手牌`);

  // 连续拆解多副牌后同样不能串（覆盖跨对局的缓存命中）
  Dec.resetCache();
  leak = 0;
  for (let i = 0; i < 40; i++) {
    const ha = H('3 3 4 5 6 7 8 9 10 J Q K A A 2 2 w');
    const hb = H('3 3 4 5 6 7 8 9 10 J Q K A A 2 2 w');
    const ida = new Set(ha.map(c => c.id));
    Dec.decompose(ha).hands.forEach(h => h.forEach(c => { if (!ida.has(c.id)) leak++; }));
    Dec.decompose(hb);
  }
  ok(leak === 0, `反复拆解后出现了不属于自己的牌（${leak} 张）`);
  Dec.resetCache();
}

console.log('=== 整局模拟（三个 AI 对打） ===');

function simulate(seedGame, diffList) {
  const diffs = diffList || ['easy', 'normal', 'hard'];
  const deck = Cards.shuffle(Cards.makeDeck());
  const hands = [deck.slice(0, 17), deck.slice(17, 34), deck.slice(34, 51)];
  const bottom = deck.slice(51);
  const landlord = seedGame % 3;
  hands[landlord] = hands[landlord].concat(bottom);
  const roles = [0, 1, 2].map(s => (s === landlord ? 'landlord' : 'farmer'));
  const played = [];
  let turn = landlord;
  let lastCombo = null, lastSeat = null, passCount = 0;
  let guard = 0;

  while (guard++ < 600) {
    const seat = turn;
    const hand = hands[seat];
    const teammateSeat = roles[seat] === 'farmer'
      ? [0, 1, 2].find(s => s !== seat && roles[s] === 'farmer')
      : landlord;

    const res = AI.decidePlay({
      difficulty: diffs[seat],
      hand: hand, seat: seat, role: roles[seat],
      landlordSeat: landlord, teammateSeat: teammateSeat,
      lastCombo: lastSeat === seat ? null : lastCombo,
      lastSeat: lastSeat, counts: hands.map(h => h.length), played: played,
      // 大师档只有拿到真实三家手牌才走完全信息分支（见 ai.js decidePlay）
      hands: diffs[seat] === 'master' ? hands.map(h => h.slice()) : null
    });

    if (res) {
      const combo = Cards.parse(res.cards);
      if (!combo) return { err: `座位 ${seat} 出了非法牌型` };
      if (lastCombo && lastSeat !== seat && !Cards.canBeat(combo, lastCombo)) {
        return { err: `座位 ${seat} 出的牌压不过上家` };
      }
      const ids = new Set(res.cards.map(c => c.id));
      hands[seat] = hand.filter(c => !ids.has(c.id));
      played.push(...res.cards);
      lastCombo = combo; lastSeat = seat; passCount = 0;
      if (hands[seat].length === 0) return { winner: seat, role: roles[seat], guard };
    } else {
      passCount++;
      if (lastCombo && passCount >= 2) { lastCombo = null; passCount = 0; }
    }
    turn = (turn + 1) % 3;
  }
  return {
    err: '对局未能在 600 步内结束（疑似死循环）' +
      `，余牌=[${hands.map(h => h.length).join(',')}]，lastSeat=${lastSeat}`
  };
}

let simOk = 0, simErr = [];
let landlordWins = 0;
for (let i = 0; i < GAME_N; i++) {
  const r = simulate(i);
  if (r.err) { simErr.push(r.err); }
  else { simOk++; if (r.role === 'landlord') landlordWins++; }
}
ok(simErr.length === 0, '整局模拟出错: ' + simErr.slice(0, 3).join(' / '));
console.log(`  ${GAME_N} 局完成 ${simOk} 局，地主胜 ${landlordWins} 局（胜率 ${(landlordWins / Math.max(1, simOk) * 100).toFixed(1)}%）`);
ok(landlordWins / Math.max(1, simOk) > 0.25 && landlordWins / Math.max(1, simOk) < 0.8,
  `地主胜率应在 25%~80% 之间，实际 ${(landlordWins / Math.max(1, simOk) * 100).toFixed(1)}%`);

// 大师档整局模拟：完全信息 + 残局推演路径只有这里会被完整走到
const MASTER_N = Number(process.env.MASTER_N || 30);
let mOk = 0, mErr = [], mMaxMs = 0;
for (let i = 0; i < MASTER_N; i++) {
  const t0 = Date.now();
  const r = simulate(i, ['master', 'master', 'master']);
  mMaxMs = Math.max(mMaxMs, Date.now() - t0);
  if (r.err) mErr.push(r.err); else mOk++;
}
ok(mErr.length === 0, '大师档整局模拟出错: ' + mErr.slice(0, 3).join(' / '));
console.log(`  大师档 ${MASTER_N} 局完成 ${mOk} 局，单局最长 ${mMaxMs} ms`);
ok(mOk === MASTER_N, `大师档 ${MASTER_N} 局应全部正常结束，实际 ${mOk} 局`);

/* ---------------- 汇总 ---------------- */
console.log('\n' + '='.repeat(56));
if (fail === 0) {
  console.log(`✅ 全部通过：${pass} 项断言`);
} else {
  console.log(`❌ 失败 ${fail} 项 / 共 ${pass + fail} 项`);
  failures.slice(0, 30).forEach(f => console.log('  - ' + f));
  process.exitCode = 1;
}
