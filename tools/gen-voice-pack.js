/* 语音方案 a —— Edge TTS 批量生成预录制音频包（一次性工具，不 入 库） */
'use strict';
var fs = require('fs');
var path = require('path');
var MsEdgeTTS = require(path.join(__dirname, '..', 'node_modules', 'msedge-tts')).MsEdgeTTS;

var OUT_DIR = path.join(__dirname, '..', 'js', 'voice');
var VOICE = 'zh-CN-YunxiaNeural';

/* ---- 权威清单与拼音命名：必须与 js/voice.js 的 MANIFESTS / PINYIN 逐字保持同步 ---- */

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

var LIST = MANIFESTS.map(function (text) {
  var p = '';
  for (var i = 0; i < text.length; i++) p += PINYIN[text[i]] || '';
  return { text: text, file: p + '.mp3' };
});
console.log('短语数: ' + LIST.length);

async function generateAll() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  var ok = 0, fail = 0;
  var t0 = Date.now();

  for (var i = 0; i < LIST.length; i++) {
    var text = LIST[i];
    var filePath = path.join(OUT_DIR, LIST[i].file);

    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 500) continue;

    // 圈/七 不走 TTS：圈 从"圆圈"帧级切割截取 quān；七 从"七条"截取
    // 前 24%+3 帧尾音。这两个文件已手动放置，exists-check 会跳过。

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
