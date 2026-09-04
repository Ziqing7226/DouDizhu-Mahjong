/* 语音方案 a —— Edge TTS 批量生成预录制音频包（一次性工具，不 入 库） */
'use strict';
var fs = require('fs');
var path = require('path');
var MsEdgeTTS = require(path.join(__dirname, '..', 'node_modules', 'msedge-tts')).MsEdgeTTS;

var OUT_DIR = path.join(__dirname, '..', 'js', 'voice');
var VOICE = 'zh-CN-YunxiaNeural';

var RANK = ['三', '四', '五', '六', '七', '八', '九', '十', '钩', '圈', 'K', '尖', '二'];
var MJ_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
var MJ_SUIT = ['万', '条', '筒'];
var MJ_HONOR = ['东风', '南风', '西风', '北风', '红中', '发财', '白板'];

var phrases = new Set();
['小王', '大王'].forEach(function (r) { phrases.add(r); });
RANK.forEach(function (r) { phrases.add(r); });
RANK.forEach(function (r) { phrases.add('对' + r); });
// 三个X 全量 13 档（与 voice.js manifest 对齐，缺一个就会静默回退系统 TTS）
RANK.forEach(function (r) { phrases.add('三个' + r); });
['三带一', '三带二', '顺子', '连对', '飞机', '飞机带单', '飞机带对',
 '四带二', '四带两对', '王炸', '炸弹'].forEach(function (p) { phrases.add(p); });
['不要', '过', '不叫', '一分', '两分', '三分'].forEach(function (p) { phrases.add(p); });
phrases.add('叫地主');
['加倍', '不加倍', '超级加倍'].forEach(function (p) { phrases.add(p); });
MJ_NUM.forEach(function (n) { MJ_SUIT.forEach(function (s) { phrases.add(n + s); }); });
MJ_HONOR.forEach(function (h) { phrases.add(h); });
['吃', '碰', '杠', '暗杠', '加杠', '胡了', '我胡了'].forEach(function (p) { phrases.add(p); });
['东位胡了', '南位胡了', '西位胡了', '北位胡了'].forEach(function (p) { phrases.add(p); });

var LIST = Array.from(phrases);
console.log('短语数: ' + LIST.length);

async function generateAll() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  var ok = 0, fail = 0;
  var t0 = Date.now();

  for (var i = 0; i < LIST.length; i++) {
    var text = LIST[i];
    var safeName = text.replace(/[\\/:*?"<>|\s]/g, '_');
    var filePath = path.join(OUT_DIR, safeName + '.mp3');

    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 500) continue;

    try {
      var tts = new MsEdgeTTS();
      await tts.setMetadata(VOICE, 'audio-24khz-48kbitrate-mono-mp3');
      var result = tts.toStream(text);
      var chunks = [];
      await new Promise(function (resolve, reject) {
        result.audioStream.on('data', function (c) { chunks.push(c); });
        result.audioStream.on('end', resolve);
        result.audioStream.on('error', reject);
      });
      var buf = Buffer.concat(chunks);
      fs.writeFileSync(filePath, buf);
      ok++;
      // 每个 TTS 实例用完关闭
      tts.close();
    } catch (e) {
      console.error('  ✗ ' + text + ': ' + (e.message || e.code || 'unknown'));
      fail++;
    }
    if ((i + 1) % 20 === 0) console.log('  进度 ' + (i + 1) + '/' + LIST.length + ' (' + Math.round((Date.now() - t0) / 1000) + 's)');
  }

  console.log('完成: ' + ok + ' 生成, ' + fail + ' 失败, 耗时 ' + Math.round((Date.now() - t0) / 1000) + 's');
  if (fail > 0) process.exitCode = 1;
}

generateAll().then(function () {
  console.log('全部完成');
}).catch(function (e) {
  console.error('FATAL:', e);
  process.exit(1);
});
