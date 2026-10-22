'use strict';
/* node radio_api.test.cjs —— 在一个临时目录里把 radio_api 整个跑一遍：
   假宿主（SSE 一段段回话）、假念字、假搜歌、假记忆。不碰真服务器、不花钱。 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const here = __dirname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-test-'));
const site = path.join(tmp, 'site'), fz = path.join(tmp, 'fz');
fs.mkdirSync(site); fs.mkdirSync(fz);
fs.copyFileSync(path.join(here, 'radio_api.cjs'), path.join(site, 'radio_api.cjs'));
fs.copyFileSync(path.join(here, 'radio_parse.cjs'), path.join(site, 'radio_parse.cjs'));
fs.writeFileSync(path.join(tmp, 'token'), 'tok123\n');
/* 假的 ncm-cli 日志：开头先有几行旧的（不该算进这一段） */
const ncmLog = path.join(tmp, 'app.log');
fs.writeFileSync(ncmLog, '[2026-10-17 16:00:00.000] [INFO ] [NeteaseApi] GET /openapi/music/basic/search/song/get/v3 bizContent={"keyword":"旧的那次","limit":"5"}\n');

/* 假模块：念字给个假 hash，搜歌只认两首，记忆记到数组里 */
fs.mkdirSync(path.join(site, 'host'));
fs.writeFileSync(path.join(site, 'host', 'tts.js'), `
  let n = 0, mode = 'mm'; const calls = [], opts = [];
  module.exports = { calls, opts, setMode: m => { mode = m; }, CACHE_DIR: ${JSON.stringify(path.join(tmp, 'tts_cache'))},
    cfg: () => mode === 'mm' ? { provider: 'minimax' } : { provider: 'elevenlabs', el_voice_id: 'v1' },
    synth: async (t, o) => { calls.push(t); opts.push(o || null); if (/念不了/.test(t)) throw new Error('ElevenLabs 挂了'); n++; return { hash: String(n).padStart(40, 'a'), via: mode === 'el' ? 'ElevenLabs' : undefined, align: mode === 'el' && !!(o && o.timestamps) }; } };`);
fs.writeFileSync(path.join(site, 'host', 'memory.js'), `
  const mem = [], events = []; module.exports = { mem, events, eventAppend: e => { events.push(e); return 1; }, remember: async (title, content, cat, imp, tags) => { mem.push({ title, content, cat, tags }); return { ok: true, id: mem.length }; } };`);

/* 假宿主：记下每次收到的东西，按台回一段写好的话 */
const got = [];
const REPLIES = {
  radio_story: ['<本子>\n真正在讲的：告别。六夜。\n</本子>', '今晚开始讲一个新的故事。名字叫《零点以后的天气预报》。', '阿岚在县城修收音机。', '[歌] Fade Into You|Mazzy Star|E-Fade|77|http://p/c.jpg'],
  radio_talk: ['嗯，听出来了。那今晚不讲道理。', '念不了的这一句'],
  radio_talk_bad: ['那放一首。', '[song:Nope|Nobody]'],
  radio_talk_qt: ['好，放这首。', '[歌] 晴天|周杰伦|E-qt|5|http://p/q.jpg'],
  radio_pillow: ['<轨道>\n1. 回家\n2. 雨夜\n3. 温存 · 晚安\n</轨道>\n<第1轨>', '[se:雨]\n[左耳]嘘。[耳语]别动。', '[贴近]我在。'],
  radio_music: [],
};
let slow = false, forceTalk = null;
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c);
  req.on('end', () => {
    const j = JSON.parse(b);
    got.push({ token: req.headers['x-radio-token'], body: j });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (j.room === 'radio_music') { res.write('event: error\ndata: {"text":"模型那边超时了"}\n\n'); return res.end(); }
    if (j.message.indexOf('[电台·收台]') === 0) {
      res.write('event: bubble\ndata: ' + JSON.stringify({ i: 0, text: '<第3轨>\n晚安。\n<摘要>雨夜接她回家，她喜欢被叫名字</摘要>' }) + '\n\n');
      return res.end('event: done\ndata: {"uid":"x"}\n\n');
    }
    if (j.message.indexOf('查一下网易云') >= 0) {   /* 他在这一段里自己跑了几条 ncm-cli */
      const L = (x) => fs.appendFileSync(ncmLog, '[2026-10-17 17:00:00.000] [INFO ] [NeteaseApi] ' + x + '\n');
      L('GET /openapi/music/basic/user/profile/get/v2 bizContent={}');
      L('POST /openapi/v1/ncm/cli/manifest bizContent={"cliVersion":"0.1.7"}');
      L('GET /openapi/music/basic/search/song/get/v3 bizContent={"keyword":"YOASOBI 夜に駆ける","limit":"10"}');
      L('GET /openapi/music/basic/search/song/get/v3 → {"code":200,"data":{"records":[]}}');
      L('GET /openapi/music/basic/comments/get/v2 bizContent={"type":"song","resourceId":"ABC","limit":"5"}');
      L('POST /openapi/music/basic/user/oauth2/token/refresh/v2 bizContent={"refreshToken":"SECRET-REFRESH"}');
      L('GET /openapi/music/basic/song/detail/get/v2 bizContent={"songId":"X","withUrl":true}');
      L('GET /openapi/music/basic/search/song/get/v3 bizContent={"keyword":"YOASOBI 夜に駆ける","limit":"5"}');
    }
    const list = forceTalk || (j.message.indexOf('放一首放不了的') >= 0 ? REPLIES.radio_talk_bad : j.message.indexOf('放晴天') >= 0 ? REPLIES.radio_talk_qt : REPLIES[j.room]) || [];   /* forceTalk：v10 去重那几条用 */
    const go = () => {
      list.forEach((t, i) => res.write('event: tool\ndata: {"name":"想"}\n\n' + 'event: bubble\ndata: ' + JSON.stringify({ i, text: t }) + '\n\n'));
      res.end('event: done\ndata: {"uid":"x","bubbles":' + list.length + '}\n\n');
    };
    slow ? setTimeout(go, 300) : go();
  });
});

(async () => {
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  process.env.PORT = String(fake.address().port);
  process.env.RADIO_SITE_DIR = site;
  process.env.RADIO_DATA_DIR = fz;
  process.env.RADIO_TOKEN_FILE = path.join(tmp, 'token');
  process.env.RADIO_URL_COUNTS_AS_PLAY = '1';   /* 假宿主：取地址会被记成听过（v13 那句会出现） */
  process.env.NCM_APP_LOG = ncmLog;
  const api = require(path.join(site, 'radio_api.cjs'));
  const mem = require(path.join(site, 'host', 'memory.js')).mem;
  /* 假网易云搜索：Fade Into You 原版放不了（visible:false），Live 版能放；晚安能放；Nope 一个都放不了；搜不到的歌没有结果 */
  const searched = [];
  const fakeSearch = async kw => {
    searched.push(kw);
    if (/Fade Into You/.test(kw)) return { data: { records: [
      { id: 'E-Fade', originalId: 77, name: 'Fade Into You', artists: [{ name: 'Mazzy Star' }], visible: false },
      { id: 'E-Fade-live', originalId: 78, name: 'Fade Into You (Live)', artists: [{ name: 'Mazzy Star' }], visible: true, coverImgUrl: 'http://p1.music.126.net/x.jpg' }] } };
    if (/晚安/.test(kw)) return { data: { records: [{ id: 'E-wanan', originalId: 9, name: '晚安', artists: [{ name: '颜人中' }], visible: true, coverImgUrl: 'http://p2.music.126.net/w.jpg' }] } };
    if (/Nope/.test(kw)) return { data: { records: [{ id: 'E-nope', originalId: 1, name: 'Nope', artists: [{ name: 'Nobody' }], visible: false }] } };
    return { data: { records: [] } };
  };
  api._setSearch(fakeSearch);
  let n = 0; const ok = m => { n++; console.log('✓ ' + m); };

  /* 故事台开播：没本子 → 提示开新故事；回来本子存下、歌拆出来、念的有地址 */
  let r = await api.turn({ station: 'story', kind: 'open', opener: { title: 'Aqua', artist: '坂本龍一' } });
  assert.strictEqual(r.code, 200, JSON.stringify(r.obj));
  assert.strictEqual(got[0].token, 'tok123');
  assert.strictEqual(got[0].body.room, 'radio_story');
  assert.ok(/^\[电台·开播\]/.test(got[0].body.message) && /开一个新的/.test(got[0].body.message) && /Aqua/.test(got[0].body.message));
  assert.ok(/^radio_[0-9a-z]+$/.test(got[0].body.parts[0]._uid));
  assert.deepStrictEqual(r.obj.parts.map(p => p.type), ['say', 'song']);
  assert.ok(/^\/api\/tts\/a+1\.mp3$/.test(r.obj.parts[0].audio));
  assert.strictEqual(r.obj.parts[1].enc, 'E-Fade-live', '原版放不了，换成能放的 Live 版');
  assert.strictEqual(r.obj.parts[1].cover, 'https://p1.music.126.net/x.jpg');
  ok('故事台开播：本子、念、歌（换成能放的版本）');

  let st = JSON.parse(fs.readFileSync(path.join(site, 'radio_state.json'), 'utf8')).stations.story;
  assert.ok(/告别/.test(st.bible) && /阿岚/.test(st.tail) && st.lastSong.title === 'Fade Into You (Live)');
  r = await api.turn({ station: 'story', kind: 'open' });
  assert.ok(/本子：\n真正在讲的/.test(got[1].body.message) && /上回讲到这里/.test(got[1].body.message));
  ok('下次开播把本子和上回讲到哪带给他');

  r = await api.turn({ station: 'story', kind: 'next' });
  assert.ok(/^\[电台·下一段\]/.test(got[2].body.message) && !/刚放完的是/.test(got[2].body.message), '上一段那首被挡掉了：不说「刚放完」');
  assert.ok(/你挑的《Fade Into You》这几天刚放过/.test(got[2].body.message), got[2].body.message);
  ok('下一段：上一段没排进歌就不说「刚放完」（v11）');

  /* 夜话：热线原话带过去；有一块念不了 → 那块没地址、带原因，别的照常 */
  r = await api.turn({ station: 'talk', kind: 'her', text: '今天其实有点累' });
  assert.strictEqual(got[3].body.message, '[电台·热线] 今天其实有点累');
  assert.strictEqual(r.obj.parts.length, 1);
  assert.strictEqual(r.obj.parts[0].ttsErr, 'ElevenLabs 挂了');
  assert.strictEqual(r.obj.parts[0].audio, undefined);
  assert.strictEqual(r.code, 200);
  ok('热线原话原样带过去；念不出来的那块带原因，整段照样回来');

  r = await api.turn({ station: 'talk', kind: 'memo', text: '   ' });
  assert.strictEqual(r.code, 400);
  ok('空纸条挡掉');

  /* 他点了一首放不了的：不排进去，下一段告诉他换一首 */
  r = await api.turn({ station: 'talk', kind: 'memo', text: '放一首放不了的' });
  assert.deepStrictEqual(r.obj.parts.map(p => p.type), ['say', 'nosong']);
  assert.deepStrictEqual(r.obj.parts[1], { type: 'nosong', title: 'Nope', artist: 'Nobody', text: '因合作方要求，暂不支持收听', ori: '1' }, 'v12：放不了的留一行，带网易云的说法和编号');
  r = await api.turn({ station: 'talk', kind: 'next' });
  assert.ok(/《Nope》在这边放不出来/.test(got[got.length - 1].body.message), got[got.length - 1].body.message);
  assert.ok(/网易云的说法：《Nope》因合作方要求，暂不支持收听。/.test(got[got.length - 1].body.message), 'v12：告诉他网易云的说法');
  r = await api.turn({ station: 'talk', kind: 'next' });
  assert.ok(!/放不出来/.test(got[got.length - 1].body.message), '说过一次就不再说');
  ok('放不了的歌不排进去，下一段告诉他一次');

  /* 枕話：点单带过去，轨道表存下，位置和音效拆开，收台摘要进记忆 */
  r = await api.turn({ station: 'pillow', kind: 'open', order: { scene: '下雨，我加班到很晚，你来接我', mood: '坏一点', level: '不收着' } });
  const pm = got[got.length - 1].body.message;
  assert.ok(/情境＝下雨，我加班到很晚，你来接我；他今晚＝坏一点；尺度＝不收着/.test(pm));
  assert.deepStrictEqual(r.obj.tracks, ['回家', '雨夜', '温存 · 晚安']);
  assert.deepStrictEqual(r.obj.parts.map(p => p.type + ':' + (p.pos || '')), ['se:', 'say:左耳', 'say:贴近']);
  assert.strictEqual(r.obj.parts[1].text, '[low and close to her ear, unhurried] 嘘。[whispers] 别动。');
  assert.strictEqual(r.obj.parts[1].show, '嘘。别动。');
  ok('枕話开播：点单、轨道、左右耳、音效');

  r = await api.turn({ station: 'pillow', kind: 'open', order: { mood: '乱写的', level: '也乱写' } });
  assert.ok(/情境＝随机；他今晚＝宠着你；尺度＝甜/.test(got[got.length - 1].body.message));
  ok('点单乱填的退回默认，不把怪东西塞给他');

  r = await api.turn({ station: 'pillow', kind: 'bye' });
  assert.strictEqual(mem.length, 1);
  assert.ok(/^枕話 · \d\d-\d\d$/.test(mem[0].title) && /她喜欢被叫名字/.test(mem[0].content) && mem[0].cat === '电台');
  assert.ok(r.obj.parts.every(p => !/摘要|喜欢被叫/.test(p.text || '')));
  ok('收台：摘要进记忆，不念出来');

  /* 宿主报错 → 502 带原因 */
  r = await api.turn({ station: 'music', kind: 'next' });
  assert.strictEqual(r.code, 502);
  assert.ok(/超时/.test(r.obj.error));
  ok('宿主那边出错，原因带回来');

  /* 同一个台同时只做一段 */
  slow = true;
  const a = api.turn({ station: 'talk', kind: 'next' });
  const b2 = await api.turn({ station: 'talk', kind: 'next' });
  assert.strictEqual(b2.code, 409);
  assert.strictEqual((await a).code, 200);
  slow = false;
  ok('同一个台连点两下，第二下 409');

  r = await api.turn({ station: 'nope', kind: 'next' });
  assert.strictEqual(r.code, 400);
  r = await api.turn({ station: 'constructor', kind: 'next' });
  assert.strictEqual(r.code, 400);
  r = await api.turn({ station: 'talk', kind: 'rm -rf' });
  assert.strictEqual(r.code, 400);
  ok('乱写的台和 kind 挡掉');

  /* ncm-cli 这会儿搜不了（返回 null）：他点的歌不算「放不了」，照宿主歌卡的编号排进去，也不告诉他换 */
  api._setSearch(async () => null);
  r = await api.turn({ station: 'talk', kind: 'memo', text: '放晴天' });
  assert.deepStrictEqual(r.obj.parts.map(p => p.type + ':' + (p.enc || '')), ['say:', 'song:E-qt']);
  r = await api.turn({ station: 'talk', kind: 'next' });
  assert.ok(!/放不出来/.test(got[got.length - 1].body.message));
  api._setSearch(fakeSearch);
  ok('搜歌那条路挂了：不冤枉他点的歌');

  /* v5：一批纸条一起送，编号给他 */
  r = await api.turn({ station: 'talk', kind: 'memo', texts: ['主播主播你有女朋友吗', '  ', '你声音好好听'] });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(got[got.length - 1].body.message, '[电台·纸条] 这一段攒了 2 张纸条，一起念：\n1. 主播主播你有女朋友吗\n2. 你声音好好听');
  r = await api.turn({ station: 'talk', kind: 'memo', texts: ['就一张'] });
  assert.strictEqual(got[got.length - 1].body.message, '[电台·纸条] 就一张');
  r = await api.turn({ station: 'talk', kind: 'memo', texts: ['  '] });
  assert.strictEqual(r.code, 400);
  ok('纸条攒一批：编号一起给他，只有一张就照原样，空的挡掉');

  /* v5：念字落到 MiniMax —— 不选 ElevenLabs 就送圆括号；选了但这句落回 MiniMax，换写法重念，之后直接送 MiniMax 的写法 */
  const ttsMod = require(path.join(site, 'host', 'tts.js'));
  assert.strictEqual(api.forMiniMax('[low and close to her ear, unhurried] 嘘。[sighs] 别动。[whispers] 就这样。'), '嘘。(sighs) 别动。就这样。');
  ttsMod.calls.length = 0; ttsMod.setMode('mm');
  r = await api.turn({ station: 'pillow', kind: 'open', order: { mood: '宠着你', level: '甜' } });
  assert.ok(ttsMod.calls.length >= 2 && ttsMod.calls.every(t => t.indexOf('[') < 0), '设定里不是 ElevenLabs：一个方括号都不送');
  ttsMod.calls.length = 0; ttsMod.opts.length = 0; ttsMod.setMode('el');
  r = await api.turn({ station: 'pillow', kind: 'open', order: { mood: '宠着你', level: '甜' } });
  assert.ok(ttsMod.calls.some(t => /\[low and close/.test(t)), 'ElevenLabs 正常：照原样送');
  /* SEG:RADIO v14 —— 枕話单独用稳定度 0.75，别的台不带 */
  assert.ok(ttsMod.opts.length >= 2 && ttsMod.opts.every(o => o && o.stability === 0.75), '枕話每句都带 stability 0.75：' + JSON.stringify(ttsMod.opts));
  ttsMod.opts.length = 0;
  forceTalk = ['今晚就聊两句。'];
  await api.turn({ station: 'talk', kind: 'next' });
  forceTalk = null;
  assert.ok(ttsMod.opts.length >= 1 && ttsMod.opts.every(o => !o || o.stability == null), '别的台不带稳定度：' + JSON.stringify(ttsMod.opts));
  ttsMod.opts.length = 0;
  ttsMod.calls.length = 0; ttsMod.setMode('elbroke');
  r = await api.turn({ station: 'pillow', kind: 'open', order: { mood: '宠着你', level: '甜' } });
  const withBr = ttsMod.calls.filter(t => /\[/.test(t)), noBr = ttsMod.calls.filter(t => t.indexOf('[') < 0);
  assert.ok(withBr.length >= 1 && withBr.every(t => noBr.indexOf(api.forMiniMax(t)) >= 0), '落回 MiniMax 的每一句都换写法重念了');
  assert.ok(r.obj.parts.filter(x => x.type === 'say').every(x => x.audio), '每块都有声音');
  ttsMod.calls.length = 0;
  r = await api.turn({ station: 'pillow', kind: 'open', order: { mood: '宠着你', level: '甜' } });
  assert.ok(ttsMod.calls.length >= 2 && ttsMod.calls.every(t => t.indexOf('[') < 0), '之后二十分钟直接送 MiniMax 的写法，不再白念');
  assert.ok(/\[low and close/.test(r.obj.parts.find(x => x.type === 'say' && x.pos === '左耳').text), '给页面的 text 不变');
  ttsMod.setMode('mm');
  r = await api.turn({ station: 'pillow', kind: 'bye' });   /* 收掉，后面的收尾测试从干净的枕話开始 */
  ok('MiniMax：方括号不会被照字念');

  /* v3：他这一段在网易云上查了什么 —— 只给人话，旧的不算、登录的不算、取播放地址的不算、token 不漏 */
  r = await api.turn({ station: 'talk', kind: 'memo', text: '帮我查一下网易云' });
  assert.deepStrictEqual(r.obj.ncm, ['搜「YOASOBI 夜に駆ける」', '翻评论区']);
  assert.ok(JSON.stringify(r.obj).indexOf('SECRET') < 0);
  r = await api.turn({ station: 'talk', kind: 'next' });
  assert.strictEqual(r.obj.ncm, undefined, '没查就不带');
  ok('网易云：做完带上他查了什么');

  /* 做的时候：/api/radio/state 回到现在为止查了什么 */
  slow = true;
  const pend = api.turn({ station: 'talk', kind: 'memo', text: '再查一下网易云' });
  await new Promise(res => setTimeout(res, 100));
  const st0 = await new Promise(resolve => {
    const res = { writeHead(c) { this.c = c; }, end(x) { resolve(JSON.parse(x)); } };
    api.handle({ method: 'GET', url: '/api/radio/state?station=talk' }, res);
  });
  assert.strictEqual(st0.busy, true);
  assert.deepStrictEqual(st0.ncm, ['搜「YOASOBI 夜に駆ける」', '翻评论区'], '他还没说完，已经查的先露出来');
  await pend; slow = false;
  const st1 = await new Promise(resolve => {
    const res = { writeHead(c) { this.c = c; }, end(x) { resolve(JSON.parse(x)); } };
    api.handle({ method: 'GET', url: '/api/radio/state?station=talk' }, res);
  });
  assert.deepStrictEqual(st1.ncm, [], '做完就清掉');
  ok('网易云：做的时候 state 里就能看到，做完清掉');

  /* v3：音效素材库 —— 列表、取文件、乱写的名字 */
  const seDir = path.join(fz, 'radio_se');
  fs.mkdirSync(seDir, { recursive: true });
  fs.writeFileSync(path.join(seDir, '轻吻.mp3'), Buffer.alloc(900, 7));
  fs.writeFileSync(path.join(seDir, '雨.mp3'), Buffer.alloc(100, 7));   /* 太小，当没有 */
  const { Writable } = require('stream');
  const getRaw = (u) => new Promise(resolve => {
    const chunks = [];
    const res = new Writable({ write(c, e, cb) { chunks.push(c); cb(); } });
    res.writeHead = function (c, h) { this.c = c; this.h = h; };
    const end0 = res.end.bind(res);
    res.end = function (x) { if (x) chunks.push(Buffer.from(x)); end0(); resolve({ c: this.c, h: this.h, b: Buffer.concat(chunks) }); return this; };
    res.on('finish', () => resolve({ c: res.c, h: res.h, b: Buffer.concat(chunks) }));
    api.handle({ method: 'GET', url: u }, res);
  });
  let g = await getRaw('/api/radio/se');
  const have = JSON.parse(g.b.toString()).have;
  assert.deepStrictEqual(Object.keys(have), ['轻吻']);
  g = await getRaw('/api/radio/se/' + encodeURIComponent('轻吻') + '.mp3');
  assert.strictEqual(g.c, 200); assert.strictEqual(g.b.length, 900); assert.strictEqual(g.h['Content-Type'], 'audio/mpeg');
  g = await getRaw('/api/radio/se/' + encodeURIComponent('亲吻') + '.mp3');
  assert.strictEqual(g.c, 404);
  g = await getRaw('/api/radio/se/..%2F..%2Ftoken.mp3');
  assert.strictEqual(g.c, 404);
  await assert.rejects(api.genSe('舌吻'), /没有/);
  process.env.ELEVENLABS_API_KEY = 'k-test';
  const sent = [];
  api._setSePost(async (c, key, body, tun) => { sent.push([key, body.duration_seconds, /one-shot/i.test(body.text)]); return Buffer.alloc(3000, 1); });
  await api.genSe('轻吻');
  assert.deepStrictEqual(sent, [['k-test', 0.6, true]]);
  assert.strictEqual(fs.statSync(path.join(seDir, '轻吻.mp3')).size, 3000);
  assert.strictEqual(fs.statSync(path.join(seDir, '轻吻.mp3.bak')).size, 900, '旧的留成 .bak');
  delete process.env.ELEVENLABS_API_KEY;
  ok('音效素材库：列表只算够大的、取文件、没有的和乱写的 404、生成时旧的留 .bak');

  /* v4：冷场半小时自己收 —— 夜話 / 故事进事件流，枕話进记忆；收过的清掉 */
  const events = require(path.join(site, 'host', 'memory.js')).events;
  const asked = [];
  api._setAsk(async prompt => { asked.push(prompt); return '冥河：今晚聊了下班路上的风，她说有点累。'; });
  const stFile = path.join(site, 'radio_state.json');
  const night = k => (JSON.parse(fs.readFileSync(stFile, 'utf8')).stations[k] || {}).night;
  const age = (k, min) => { const j = JSON.parse(fs.readFileSync(stFile, 'utf8')); j.stations[k].night.lines.forEach(l => { l.t -= min * 60000; }); fs.writeFileSync(stFile, JSON.stringify(j)); };
  assert.ok(night('talk') && night('talk').lines.length >= 3);
  assert.strictEqual(await api.digest('talk', false), false, '还没冷场半小时，不收');
  age('talk', 31);
  const ev0 = events.length;
  assert.strictEqual(await api.digest('talk', false), true);
  assert.strictEqual(events.length, ev0 + 1);
  assert.strictEqual(events[ev0].content, '电台·夜話：今晚聊了下班路上的风，她说有点累。');
  assert.strictEqual(events[ev0].source, 'radio');
  assert.ok(/她（热线）：今天其实有点累/.test(asked[0]) && /你：/.test(asked[0]), '她插的话、他念的都带给他');
  assert.strictEqual(night('talk'), undefined, '收过的清掉');
  assert.strictEqual(await api.digest('talk', true), false, '没有新的就不收第二次');
  ok('冷场半小时：夜話收一句进事件流，收过的清掉');

  /* SEG:RADIO v16 —— 收台时顺手起一个标题，进 radio_archive，回放单子用 */
  {
    const tl = fs.readFileSync(api.archFile('talk'), 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.kind === 'title');
    assert.strictEqual(tl.length, 1, '收一次起一个标题');
    assert.strictEqual(tl[0].title, '今晚聊了下班路上的风，她说有点累', '去掉「冥河：」和句号、最多十六个字：' + tl[0].title);
    assert.ok(/给这一晚起一个标题/.test(asked[1]) && !/不写露骨/.test(asked[1]), '夜話的标题那句');
    assert.strictEqual(api.cleanTitle('标题：《雨夜里的收音机》。'), '雨夜里的收音机');
    assert.strictEqual(api.cleanTitle('You\'ve hit your session limit'), '');
    const nl = api.nightsOf(api.readArchive('talk'));
    const segsN = nl[nl.length - 1].segs.filter(e => e.kind !== 'title').length;
    const call0 = (u) => new Promise(resolve => { const res = { writeHead(c) { this.c = c; }, end(s) { resolve({ c: this.c, j: JSON.parse(s) }); } }; api.handle({ method: 'GET', url: u }, res); });
    const o0 = await call0('/api/radio/replay?station=talk');
    assert.strictEqual(o0.j.nights[0].title, '今晚聊了下班路上的风，她说有点累');
    assert.strictEqual(o0.j.nights[0].n, segsN, '标题那行不算一段');
  }
  ok('收台时起标题：记进回放、单子带 title、不算一段（v16）');

  /* 枕話：收台那句 <摘要> 已经进了记忆，今晚就清了；没说收台的，冷场了替他收一句进记忆 */
  assert.strictEqual(night('pillow'), undefined, '收台用了他自己的摘要');
  r = await api.turn({ station: 'pillow', kind: 'open', order: { scene: '下雨', mood: '宠着你', level: '甜' } });
  age('pillow', 40);
  const m0 = mem.length;
  assert.strictEqual(await api.digest('pillow', false), true);
  assert.strictEqual(mem.length, m0 + 1);
  assert.ok(/^枕話 · \d\d-\d\d$/.test(mem[m0].title) && /情境：下雨/.test(mem[m0].content) && mem[m0].cat === '电台');
  assert.ok(/不复述露骨的细节/.test(asked[asked.length - 1]));
  assert.ok(/枕話台：标题含蓄一点/.test(asked[asked.length - 1]), 'v16：枕話也起标题，含蓄');
  const pst = JSON.parse(fs.readFileSync(stFile, 'utf8')).stations.pillow;
  assert.ok(!pst.night && pst.tracks === null, '收完轨道表也清了');
  ok('冷场半小时：枕話替他收一句进记忆');

  /* 故事台说了收台：不等三十分钟，当场收 */
  r = await api.turn({ station: 'story', kind: 'bye' });
  await new Promise(res => setTimeout(res, 50));
  assert.ok(/^电台·故事：/.test(events[events.length - 1].content));
  assert.strictEqual(night('story'), undefined);
  ok('别的台收台：当场收');

  /* 收不成：记着，三次都不成就算了 */
  api._setAsk(async () => { throw new Error('网关挂了'); });
  r = await api.turn({ station: 'talk', kind: 'next' });
  for (let k = 0; k < 2; k++) { assert.strictEqual(await api.digest('talk', true), false); assert.ok(night('talk'), '前两次没成，留着'); }
  assert.strictEqual(await api.digest('talk', true), false);
  assert.strictEqual(night('talk'), undefined, '第三次还不成就放下');
  ok('收不成：三次以后放下，不每五分钟问一遍');

  /* 开场歌：她的文件优先；搜不到的跳过；上回放过的先不放 */
  fs.writeFileSync(path.join(fz, 'radio_openers.json'), JSON.stringify({ talk: ['搜不到的歌|谁', '晚安|颜人中'] }));
  const call = (u) => new Promise(resolve => {
    const res = { writeHead(c) { this.c = c; }, end(s) { resolve({ c: this.c, j: JSON.parse(s) }); } };
    api.handle({ method: 'GET', url: u }, res);
  });
  let o = await call('/api/radio/opener?station=talk');
  assert.strictEqual(o.c, 200);
  assert.strictEqual(o.j.song.title, '晚安');
  assert.ok(/^https:/.test(o.j.song.cover));
  o = await call('/api/radio/opener?station=pillow');
  assert.strictEqual(o.j.song.title, 'Fade Into You (Live)');
  assert.strictEqual(o.j.song.enc, 'E-Fade-live');
  o = await call('/api/radio/state?station=pillow');
  assert.strictEqual(o.j.tracks, null);
  o = await call('/api/radio/state?station=../etc');
  assert.strictEqual(o.c, 400);
  o = await call('/api/radio/opener?station=__proto__');
  assert.strictEqual(o.c, 400);
  ok('开场歌、状态、乱写的台名');

  /* SEG:RADIO v10 —— 歌词：带时间的 LRC 拆成一句一句，翻译按时间对上，作词作曲那几行去掉 */
  const lrc = '[00:00.00] 作词 : 林夕\n[00:01.50] 作曲 : 某人\n[00:12.34]第一句\n[00:20.5]第二句\n[01:02.345][01:30.00]副歌\n没时间戳的那行\n';
  const tl = '[00:12.34]first line\n[00:20.50]second\n';
  const lines = api.parseLrc(lrc);
  assert.deepStrictEqual(lines.map(l => [l.t, l.x]), [[0, '作词 : 林夕'], [1.5, '作曲 : 某人'], [12.34, '第一句'], [20.5, '第二句'], [62.345, '副歌'], [90, '副歌']]);
  const ly = api.buildLyric({ data: { lyric: lrc, transLyric: tl } });
  assert.strictEqual(ly.pure, false);
  assert.deepStrictEqual(ly.lines, [{ t: 12.34, x: '第一句', tr: 'first line' }, { t: 20.5, x: '第二句', tr: 'second' }, { t: 62.35, x: '副歌' }, { t: 90, x: '副歌' }]);
  assert.deepStrictEqual(api.buildLyric({ data: { pureMusic: true } }), { pure: true, lines: [] });
  assert.deepStrictEqual(api.buildLyric({ data: { lyric: '一行没有时间戳\n' } }), { pure: false, lines: [] });
  let asks = 0;
  api._setLyric(async enc => { asks++; return enc === 'E-dead' ? null : { data: { lyric: '[00:01.00]嗨' } }; });
  o = await call('/api/radio/lyric?enc=E1');
  assert.strictEqual(o.c, 200);
  assert.deepStrictEqual(o.j, { pure: false, lines: [{ t: 1, x: '嗨' }] });
  await call('/api/radio/lyric?enc=E1');
  assert.strictEqual(asks, 1, '同一首记住了，不再问网易云');
  o = await call('/api/radio/lyric?enc=E-dead');
  assert.deepStrictEqual(o.j, { pure: false, lines: [] });
  await call('/api/radio/lyric?enc=E-dead');
  assert.strictEqual(asks, 3, '没取到的不记，下回再取');
  o = await call('/api/radio/lyric?enc=' + encodeURIComponent('a b;rm'));
  assert.deepStrictEqual(o.j, { pure: false, lines: [] });
  assert.strictEqual(asks, 3, '乱写的编号不去问');
  ok('歌词：带时间拆句、翻译对上、作词作曲去掉、记住取过的');

  /* SEG:RADIO v10 —— 放不出来那几样：名字差一两个字也认；带歌手搜不到，再光按歌名搜 */
  assert.ok(api.near('久石让', '久石譲') && api.near('米津玄师', '米津玄師') && api.near('maz', 'mazzystar'));
  assert.ok(!api.near('陈粒', '陈立') && !api.near('海浪', '海风') && !api.near('abcd', 'abce') && !api.near('', 'x'));
  assert.strictEqual(api.songId('你啊你啊 (Live)', '魏如萱'), api.songId('你啊你啊', '魏如萱 / 某人'));
  const s2 = [];
  api._setSearch(async (kw, lim) => {
    s2.push(kw + '#' + lim);
    if (kw === '久石譲 Summer') return { data: { records: [{ id: 'E-sum', originalId: 3, name: 'Summer', artists: [{ name: '久石让' }], visible: true }] } };
    if (kw === '某乐队 冷门歌') return { data: { records: [{ id: 'E-cov', originalId: 4, name: '冷门歌', artists: [{ name: '翻唱的人' }], visible: true }] } };
    if (kw === '冷门歌') return { data: { records: [{ id: 'E-cov', originalId: 4, name: '冷门歌', artists: [{ name: '翻唱的人' }], visible: true },
      { id: 'E-real', originalId: 5, name: '冷门歌', artists: [{ name: '某乐队' }], visible: true }] } };
    return { data: { records: [] } };
  });
  let fp = await api.findPlayable('Summer', '久石譲', {});
  assert.strictEqual(fp && fp.enc, 'E-sum', '久石譲 / 久石让 认成同一个人');
  fp = await api.findPlayable('冷门歌', '某乐队', {});
  assert.strictEqual(fp && fp.enc, 'E-real', '带歌手搜只有翻唱，光按歌名再搜一次找到原唱');
  assert.deepStrictEqual(s2, ['久石譲 Summer#12', '某乐队 冷门歌#12', '冷门歌#20']);
  api._setSearch(fakeSearch);
  ok('放不出来：名字差一两个字也认、带歌手搜不到再光按歌名搜');

  /* SEG:RADIO v10 —— 去重：他自己挑的撞上七天里放过的不排、下一段告诉他；她点的照放；开播带两张单子 */
  forceTalk = ['再放一首。', '[歌] 晚安|颜人中|E-x|1|http://p/x.jpg'];
  r = await api.turn({ station: 'talk', kind: 'next' });
  assert.deepStrictEqual(r.obj.parts.map(p => p.type), ['say'], '晚安刚开场放过，他又挑 —— 不排');
  r = await api.turn({ station: 'talk', kind: 'next' });
  assert.ok(/你挑的《晚安》这几天刚放过，这回没放/.test(got[got.length - 1].body.message), got[got.length - 1].body.message);
  r = await api.turn({ station: 'talk', kind: 'req', text: '再放一遍晚安' });
  assert.deepStrictEqual(r.obj.parts.map(p => p.type + ':' + (p.enc || '')), ['say:', 'song:E-wanan'], '她点的照放');
  forceTalk = null;
  r = await api.turn({ station: 'talk', kind: 'next' });
  assert.ok(/^\[电台·下一段\]\n刚放完的是《晚安/.test(got[got.length - 1].body.message), '上一段真排进去的那首才说「刚放完」');
  const nl = JSON.parse(fs.readFileSync(stFile, 'utf8')).stations.talk.night.lines;
  assert.ok(nl.some(l => l.dropped && l.dropped.indexOf('晚安') >= 0), '挡掉的歌记进今晚');
  r = await api.turn({ station: 'talk', kind: 'open' });
  const om = got[got.length - 1].body.message;
  assert.ok(/这七天电台放过的（别再点，换没放过的）：《晚安》颜人中、/.test(om) && /《晴天》/.test(om), om);
  assert.ok(/翻她的听歌记录时分清：.*上面这七天电台放过的 —— 都是电台放的，不是她自己点开听的.*红心最准/.test(om), 'v13：翻听歌记录那句 ' + om);
  assert.ok(!/更早电台放过的/.test(om), '没有八天以前的就不提');
  assert.ok(/试过、网易云这边放不出来的（别点）：/.test(om) && /《Nope》Nobody/.test(om) && /《Ocean Eyes》Billie Eilish/.test(om), om);
  r = await api.turn({ station: 'pillow', kind: 'open', order: { mood: '宠着你', level: '甜' } });
  assert.ok(!/这七天放过的/.test(got[got.length - 1].body.message), '枕話不带单子');
  let pl = JSON.parse(fs.readFileSync(stFile, 'utf8')).played;
  assert.ok(pl.length >= 4 && pl.every(p => p.id && p.at && p.st));
  ok('去重：他挑的放过的不排、下一段告诉他；她点的照放；开播带「放过的」「放不出来的」');

  /* 开场歌：七天里放过的先不放；都放过了挑最久没放的；过了七天又能放 */
  o = await call('/api/radio/opener?station=talk');
  assert.strictEqual(o.j.song.title, '晴天', '晚安刚放过、搜不到的歌放不了 —— 拿这个台以前放过、最久没放的那首');
  const back = d => { const j = JSON.parse(fs.readFileSync(stFile, 'utf8')); j.played.forEach(p => { p.at -= d * 864e5; }); fs.writeFileSync(stFile, JSON.stringify(j)); };
  back(8);
  o = await call('/api/radio/opener?station=talk');
  assert.ok(['晚安', '晴天'].indexOf(o.j.song.title) >= 0);
  const first = o.j.song.title;
  o = await call('/api/radio/opener?station=talk');
  assert.ok(['晚安', '晴天'].indexOf(o.j.song.title) >= 0 && o.j.song.title !== first, '过了七天又能放；刚放的那首这回不放');
  pl = JSON.parse(fs.readFileSync(stFile, 'utf8')).played;
  assert.strictEqual(pl.filter(p => p.at > Date.now() - 864e5).length, 2, '开场放的也记进去');
  ok('开场歌：七天里放过的先不放、都放过挑最久没放的、过七天又能放');

  /* SEG:RADIO v13 —— 翻她听歌记录时分清：八到三十天前电台放过的也给他（只用来剔），超过三十天的不给 */
  {
    const j = JSON.parse(fs.readFileSync(stFile, 'utf8'));
    const ago = d => Date.now() - d * 864e5;
    j.played.push({ id: api.songId('旧歌', '某人'), title: '旧歌', artist: '某人 / 另一个', st: 'music', at: ago(10) });
    j.played.push({ id: api.songId('太旧的歌', '某人'), title: '太旧的歌', artist: '某人', st: 'music', at: ago(40) });
    j.played.sort((a, b) => a.at - b.at);
    fs.writeFileSync(stFile, JSON.stringify(j));
    r = await api.turn({ station: 'music', kind: 'open' });
    const m13 = got[got.length - 1].body.message;
    assert.ok(/上面这七天电台放过的，还有更早电台放过的[^\n]*《旧歌》某人 —— 都是电台放的/.test(m13), m13);
    assert.ok(!/太旧的歌/.test(m13), '三十天以前的不给');
    assert.ok(!/这七天电台放过的（别再点，换没放过的）：[^\n]*旧歌/.test(m13), '更早的不进「别再点」那张');
    process.env.RADIO_URL_COUNTS_AS_PLAY = '0';
    r = await api.turn({ station: 'music', kind: 'open' });
    assert.ok(!/翻她的听歌记录时分清/.test(got[got.length - 1].body.message), '宿主取地址不记成听过：不提');
    process.env.RADIO_URL_COUNTS_AS_PLAY = '1';
    j.played = j.played.filter(p => p.title === '旧歌');
    fs.writeFileSync(stFile, JSON.stringify(j));
    r = await api.turn({ station: 'music', kind: 'open' });
    const m13b = got[got.length - 1].body.message;
    assert.ok(!/这七天电台放过的（/.test(m13b) && /翻她的听歌记录时分清：[^\n]*更早电台放过的《旧歌》某人 —— 都是电台放的/.test(m13b), '只有更早的：也提 ' + m13b);
    j.played = [];
    fs.writeFileSync(stFile, JSON.stringify(j));
    r = await api.turn({ station: 'music', kind: 'open' });
    assert.ok(!/翻她的听歌记录时分清/.test(got[got.length - 1].body.message), '电台一首没放过就不提');
    fs.writeFileSync(stFile, JSON.stringify(Object.assign(j, { played: pl })));
  }
  ok('翻她听歌记录时分清哪些是电台放的：七天的 + 八到三十天的，超过三十天不给（v13）');

  /* SEG:RADIO v11 —— 一首放不了：把这个歌手在这边能放的几首递给他 */
  api._setSearch(async (kw, lim) => {
    if (kw === '某歌手 不能放的歌') return { data: { records: [{ id: 'X1', name: '不能放的歌', artists: [{ name: '某歌手' }], visible: false }] } };
    if (kw === '不能放的歌') return { data: { records: [{ id: 'X1', name: '不能放的歌', artists: [{ name: '某歌手' }], visible: false }] } };
    if (kw === '某歌手') return { data: { records: [
      { id: 'A1', name: '能放的一', artists: [{ name: '某歌手' }], visible: true },
      { id: 'A2', name: '能放的二 (Live)', artists: [{ name: '某歌手' }], visible: true },
      { id: 'A3', name: '放不了的三', artists: [{ name: '某歌手' }], visible: false },
      { id: 'B1', name: '别人的歌', artists: [{ name: '路人' }], visible: true }] } };
    return { data: { records: [] } };
  });
  forceTalk = ['放一首。', '[song:不能放的歌|某歌手]'];
  r = await api.turn({ station: 'talk', kind: 'next' });
  forceTalk = null;
  assert.deepStrictEqual(r.obj.parts.map(p => p.type), ['say', 'nosong']);
  r = await api.turn({ station: 'talk', kind: 'next' });
  const am = got[got.length - 1].body.message;
  assert.ok(/《不能放的歌》在这边放不出来/.test(am) && /某歌手在这边能放的：《能放的一》《能放的二》。/.test(am) && !/放不了的三|别人的歌/.test(am), am);
  api._setSearch(fakeSearch);
  ok('放不了的那首：这个歌手在这边能放的几首递给他（v11）');

  /* SEG:RADIO v18 —— 一次几首候选：放第一首能放的、七天里没放过的 */
  {
    const asked = [];
    api._setSearch(async (kw) => {
      asked.push(kw);
      if (/候选一/.test(kw)) return { data: { records: [{ id: 'Y1', name: '候选一', artists: [{ name: '甲歌手' }], visible: false }] } };
      if (/候选二/.test(kw)) return { data: { records: [{ id: 'Y2', name: '候选二', artists: [{ name: '乙歌手' }], visible: true }] } };
      if (/候选三/.test(kw)) return { data: { records: [{ id: 'Y3', name: '候选三', artists: [{ name: '丙' }], visible: true }] } };
      return { data: { records: [] } };
    });
    forceTalk = ['放一首。', '[song:候选一|甲歌手；候选二|乙歌手；候选三|丙]'];
    r = await api.turn({ station: 'talk', kind: 'next' });
    let sp = r.obj.parts.filter(p => p.type === 'song');
    assert.ok(sp.length === 1 && sp[0].title === '候选二' && sp[0].enc === 'Y2' && !sp[0].alts, '放第一首能放的：' + JSON.stringify(r.obj.parts));
    assert.ok(asked.some(k => /候选三/.test(k)), '几首是一起去看的');
    /* 同一组再来一遍：候选二刚放过，跳到候选三 */
    r = await api.turn({ station: 'talk', kind: 'next' });
    let m18 = got[got.length - 1].body.message;
    assert.ok(/候选里，《候选一》（因合作方要求，暂不支持收听）没放，放的是《候选二》。/.test(m18), m18);
    sp = r.obj.parts.filter(p => p.type === 'song');
    assert.ok(sp.length === 1 && sp[0].title === '候选三', '放过的跳过：' + JSON.stringify(r.obj.parts));
    forceTalk = null;
    r = await api.turn({ station: 'talk', kind: 'next' });
    m18 = got[got.length - 1].body.message;
    assert.ok(/《候选二》（这几天刚放过）没放，放的是《候选三》/.test(m18), m18);
    /* 一首都放不了：留一行「放不了」，下一段几首都告诉他 */
    forceTalk = ['再放一首。', '[song:候选一|甲歌手；候选四|丁]'];
    r = await api.turn({ station: 'talk', kind: 'next' });
    forceTalk = null;
    assert.deepStrictEqual(r.obj.parts.map(p => p.type + ':' + (p.title || '')), ['say:', 'nosong:候选一']);
    r = await api.turn({ station: 'talk', kind: 'next' });
    m18 = got[got.length - 1].body.message;
    assert.ok(/《候选一》《候选四》在这边放不出来/.test(m18) && !/候选里/.test(m18), m18);
    api._setSearch(fakeSearch);
  }
  ok('一次几首候选：放第一首能放的、跳过七天里放过的、都放不了才留一行（v18）');

  /* SEG:RADIO v19 —— 他先查再写：/api/radio/check */
  {
    api._setSearch(async (kw) => {
      if (/查一/.test(kw)) return { data: { records: [{ id: 'Q1', name: '查一', artists: [{ name: '甲' }], visible: false }] } };
      if (/查二/.test(kw)) return { data: { records: [{ id: 'Q2', name: '查二', artists: [{ name: '乙' }], visible: true }] } };
      if (/查三/.test(kw)) return { data: { records: [{ id: 'Q3', name: '查三', artists: [{ name: '丙' }], visible: true }] } };
      if (/查四/.test(kw)) return { data: { records: [{ id: 'Q4', name: '查四', artists: [{ name: '丁' }], visible: true }] } };
      return null;   /* 「查五」：网易云这会儿查不了 */
    });
    const hotAsked = [];
    api._setHot(async enc => { hotAsked.push(enc); return enc === 'Q2' ? { data: { hotComments: [{ content: '第一条\n热评', likedCount: 120 }, { content: '', likedCount: 3 }, { content: '第二条', likedCount: 9 }] } } : null; });
    /* 查三 这几天放过 */
    const stFile = path.join(site, 'radio_state.json');
    const j = JSON.parse(fs.readFileSync(stFile, 'utf8'));
    (j.played = j.played || []).push({ id: api.songId('查三', '丙'), title: '查三', artist: '丙', enc: 'Q3', st: 'music', at: Date.now() - 3600e3 });
    fs.writeFileSync(stFile, JSON.stringify(j));
    o = await call('/api/radio/check?songs=' + encodeURIComponent('查一|甲；查二|乙；查三|丙; 查四|丁；查五|戊；查六|己'));
    assert.strictEqual(o.c, 200);
    const sg = o.j.songs;
    assert.strictEqual(sg.length, 5, '最多五首');
    assert.ok(!sg[0].ok && sg[0].why === '因合作方要求，暂不支持收听', JSON.stringify(sg[0]));
    assert.ok(sg[1].ok && sg[1].enc === 'Q2' && !sg[1].recent, JSON.stringify(sg[1]));
    assert.deepStrictEqual(sg[1].hot, [{ text: '第一条 热评', likes: 120 }, { text: '第二条', likes: 9 }]);
    assert.ok(sg[2].ok && sg[2].recent && !('hot' in sg[2]), '放过的标出来、不翻热评：' + JSON.stringify(sg[2]));
    assert.ok(sg[3].ok && sg[3].hot === null, '翻不到热评回 null：' + JSON.stringify(sg[3]));
    assert.ok(!sg[4].ok && /查不了/.test(sg[4].why), JSON.stringify(sg[4]));
    assert.deepStrictEqual(hotAsked.sort(), ['Q2', 'Q4'], '只给能放、没放过的前两首翻热评');
    o = await call('/api/radio/check?songs=' + encodeURIComponent('查二|乙') + '&hot=0');
    assert.ok(o.j.songs[0].ok && !('hot' in o.j.songs[0]), 'hot=0 不翻');
    o = await call('/api/radio/check?songs=');
    assert.strictEqual(o.c, 400);
    j.played = j.played.filter(p => p.title !== '查三');
    fs.writeFileSync(stFile, JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(stFile, 'utf8')), { played: j.played })));
    api._setSearch(fakeSearch);
  }
  ok('先查再写：/api/radio/check 一次五首，能不能放、放没放过、前两首带热评（v19）');

  /* SEG:RADIO v12 —— 网易云的说法：没版权 / 数字专辑 / 要会员 / 没搜到；playFlag=false 的版本不挑 */
  const yes = () => true;
  assert.strictEqual(api.whyNot([{ name: 'a', visible: false, originalId: 9 }], yes, yes).text, '因合作方要求，暂不支持收听');
  assert.strictEqual(api.whyNot([{ name: 'a', visible: true, playFlag: false, songFee: 4 }], yes, yes).why, 'album');
  assert.strictEqual(api.whyNot([{ name: 'a', visible: true, playFlag: false, vipFlag: true }], yes, yes).text, 'VIP 歌曲，要开通会员');
  assert.deepStrictEqual(api.whyNot([], yes, yes), { why: 'notfound', text: '网易云上没搜到这一首' });
  api._setSearch(async kw => /专辑歌/.test(kw) ? { data: { records: [
    { id: 'P1', originalId: 31, name: '专辑歌', artists: [{ name: '某人' }], visible: true, playFlag: false, songFee: 4 }] } } : { data: { records: [] } });
  let fv = {};
  assert.strictEqual(await api.findPlayable('专辑歌', '某人', {}, fv), null, 'visible=true 但 playFlag=false：不挑');
  assert.strictEqual(fv.bad.why, 'album');
  assert.strictEqual(fv.bad.ori, '31');
  fv = {};
  await api.findPlayable('专辑歌', '某人', {}, fv);
  assert.strictEqual(fv.bad && fv.bad.why, 'album', '记住的那份也带原因');
  api._setSearch(fakeSearch);
  ok('放不了的原因：照网易云那张表翻；playFlag=false 的版本不挑（v12）');

  /* SEG:RADIO v15 —— 回放：每一段记进 radio_archive；按晚列；逐字时间；以前的歌现找编号 */
  {
    const tm = require(path.join(site, 'host', 'tts.js'));
    tm.setMode('el'); tm.opts.length = 0; api._resetEl();
    const af = api.archFile('talk');
    try { fs.unlinkSync(af); } catch (e) {}
    forceTalk = ['先说一句。', '[歌] 晚安|颜人中|E-wanan|9|http://p/w.jpg'];
    r = await api.turn({ station: 'talk', kind: 'req', text: '放晚安' });
    assert.strictEqual(r.code, 200, JSON.stringify(r.obj));
    const sayP = r.obj.parts.find(x => x.type === 'say');
    assert.ok(sayP.align && /^[0-9a-f]{40}$/.test(sayP.align.replace(/a/g, 'a')), '有逐字时间的那句带 align：' + JSON.stringify(sayP));
    assert.ok(tm.opts.some(o => o && o.timestamps === true && o.stability == null), '夜話要逐字时间、不带稳定度');
    assert.ok(!sayP.ttsErr, '念成了的那句不该带 ttsErr：' + JSON.stringify(sayP));
    tm.setMode('mm');
    r = await api.turn({ station: 'talk', kind: 'req', text: '再说一句' });
    const mmSay = r.obj.parts.find(x => x.type === 'say');
    assert.ok(mmSay.audio && !mmSay.align && !mmSay.ttsErr, 'MiniMax 念的：有声音、没逐字时间、也不算没念成：' + JSON.stringify(mmSay));
    tm.setMode('el'); api._resetEl();
    fs.writeFileSync(af, fs.readFileSync(af, 'utf8').trim().split('\n').slice(0, 1).join('\n') + '\n');   /* 只留第一段，下面接着数 */
    forceTalk = ['好。']; r = await api.turn({ station: 'talk', kind: 'her', text: '这首好听' }); forceTalk = null;
    let lines = fs.readFileSync(af, 'utf8').trim().split('\n').map(JSON.parse);
    assert.strictEqual(lines.length, 2);
    assert.deepStrictEqual(lines[0].parts.map(x => x.type), ['say', 'song']);
    assert.ok(lines[0].parts[0].show === '先说一句。' && lines[0].parts[0].audio && lines[0].parts[0].align && !('text' in lines[0].parts[0]), '记 show / audio / align，不记带标签的原文');
    assert.strictEqual(lines[0].parts[1].enc, 'E-wanan');
    assert.strictEqual(lines[0].her, '放晚安'); assert.strictEqual(lines[1].her, '这首好听');
    /* 一晚、两晚：隔三小时以上算另一晚 */
    const old = { t: Date.now() - 5 * 3600e3, kind: 'next', bf: true, parts: [{ type: 'say', show: '以前那晚的一句。', audio: '/api/tts/' + 'b'.repeat(40) + '.mp3' }, { type: 'song', title: '晚安', artist: '颜人中' }] };
    fs.writeFileSync(af, JSON.stringify(old) + '\n' + fs.readFileSync(af, 'utf8'));
    o = await call('/api/radio/replay?station=talk');
    assert.strictEqual(o.c, 200);
    assert.strictEqual(o.j.nights.length, 2, JSON.stringify(o.j));
    assert.ok(o.j.nights[0].from > o.j.nights[1].from, '新的在前');
    assert.strictEqual(o.j.nights[0].n, 2); assert.strictEqual(o.j.nights[0].her, 2); assert.deepStrictEqual(o.j.nights[0].songs, ['晚安']);
    assert.strictEqual(o.j.nights[1].back, true); assert.strictEqual(o.j.nights[1].first, '以前那晚的一句。');
    o = await call('/api/radio/replay?station=talk&night=' + o.j.nights[1].id);
    assert.strictEqual(o.j.segs.length, 1); assert.strictEqual(o.j.segs[0].parts[0].show, '以前那晚的一句。');
    o = await call('/api/radio/replay?station=talk&night=123');
    assert.strictEqual(o.c, 404);
    o = await call('/api/radio/replay?station=../x');
    assert.strictEqual(o.c, 400);
    /* 枕話单子上不露字 */
    fs.mkdirSync(api.ARCHIVE_DIR, { recursive: true });
    fs.writeFileSync(api.archFile('pillow'), JSON.stringify({ t: Date.now(), kind: 'open', parts: [{ type: 'say', show: '不该出现在单子上', audio: '/api/tts/x.mp3' }] }) + '\n');
    o = await call('/api/radio/replay?station=pillow');
    assert.ok(o.j.nights.length === 1 && !o.j.nights[0].first, '枕話的单子不带字');
    /* 逐字时间 */
    fs.mkdirSync(tm.CACHE_DIR, { recursive: true });
    const h = 'c'.repeat(40);
    fs.writeFileSync(path.join(tm.CACHE_DIR, h + '.align.json'), JSON.stringify({ characters: ['你', '好'], character_start_times_seconds: [0, 0.3], character_end_times_seconds: [0.3, 0.6] }));
    const call2 = (u) => new Promise(resolve => {
      const res = { writeHead(c) { this.c = c; }, end(s) { resolve({ c: this.c, j: JSON.parse(s) }); } };
      api.handle({ method: 'GET', url: u }, res);
    });
    o = await call2('/api/radio/align?h=' + h);
    assert.strictEqual(o.c, 200); assert.deepStrictEqual(o.j.characters, ['你', '好']);
    o = await call2('/api/radio/align?h=' + 'd'.repeat(40)); assert.strictEqual(o.c, 404);
    o = await call2('/api/radio/align?h=../../etc/passwd'); assert.strictEqual(o.c, 400);
    /* 以前只记了歌名的：现找编号 */
    o = await call('/api/radio/findsong?title=' + encodeURIComponent('晚安') + '&artist=' + encodeURIComponent('颜人中'));
    assert.strictEqual(o.c, 200); assert.strictEqual(o.j.song.enc, 'E-wanan');
    o = await call('/api/radio/findsong?title=Nope&artist=Nobody'); assert.strictEqual(o.c, 404);
    tm.setMode('mm');
  }
  ok('回放：每段记进 radio_archive、按晚列（枕話不露字）、逐字时间、以前的歌现找编号（v15）');


  console.log('\n' + n + ' 组都过了');
  fake.close();
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch(e => { console.error('✗', e); process.exit(1); });
