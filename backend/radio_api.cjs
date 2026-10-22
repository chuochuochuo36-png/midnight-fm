'use strict';
/* MIDNIGHT FM · 深夜电台 —— 后端（radio_api.cjs）

   一台只放给一个人听的 AI 电台。四个台，每个台是宿主里一个单独的会话（room），主持人在那个会话里一段一段往下做：
     story  → room radio_story   故事 · 一夜讲完一个故事，开新故事先写 <本子>
     talk   → room radio_talk    夜話
     music  → room radio_music   音樂
     pillow → room radio_pillow  枕話（藏起来的台，乙女音声那一路；亲密规矩要你自己补，见 prompts/pillow.md）
   每个台的规矩是 prompts/common.md + prompts/<台>.md 拼成的一份（scripts/build-styles.cjs），宿主把它放在那个会话的开头。

   GET  /api/radio/state?station=   这个台现在到哪了（轨道表、本子有没有、上回的歌、正在查网易云的什么）
   GET  /api/radio/opener?station=  点开先放的那首（马上能放，不等他）
   GET  /api/radio/lyric?enc=       这首歌带时间的歌词（滚动歌词用，要 ncm-cli）
   GET  /api/radio/se               音效素材库里有哪几个；GET /api/radio/se/<名字>.mp3 取文件
   GET  /api/radio/replay?station=  回放：这个台以前的每一晚（标题、几点到几点、几段）；带 &night=<id> 回那一晚的每一段
   GET  /api/radio/align?h=         这一句的逐字时间（字幕按它亮字）
   GET  /api/radio/findsong?title=&artist=   以前只记了歌名的那首，现找能放的版本
   GET  /api/radio/check?songs=歌名|歌手；…&hot=1   放之前先查：每首能不能放（不能的话网易云怎么说）、这几天放没放过；
                                    能放、没放过的前两首带五条热评。给主持人的查歌工具用（examples/song_check_mcp.py）
   POST /api/radio/turn             让他做一段：{ station, kind, text?, texts?, order?, opener? }
        kind: open（开播）/ next（下一段）/ her（热线）/ memo（纸条）/ req（点歌）/ bye（收台）
        回：{ ok, parts:[ {type:'say', text, show, pos, audio, align?} | {type:'se', name, pos} | {type:'song', title, artist, enc, ori, cover}
                         | {type:'bgm', mood} | {type:'gap', ms} | {type:'water', name}
                         | {type:'nosong', title, artist, text, ori} ], tracks, trackNo, ncm, ms }

   ── 这个模块离不开宿主，要它提供这几样（见 README「接到你自己的 AI 上」）──
   · POST /api/chat/stream（本机，PORT）：{ message, room, via, parts } → SSE，事件 bubble {text} / error {text} / done。
     同一个 room 接着上一轮往下聊；规矩、历史、排队都是宿主那边的事。
   · host/tts.js     synth(text, { timestamps?, stability? }) → { hash, via?, align?, skipped? }，念好的音频由宿主放在 /api/tts/<hash>.mp3；
                     要了 timestamps 就把逐字时间存在 CACHE_DIR/<hash>.align.json；cfg() → { provider, el_voice_id, … }。自带一份 ElevenLabs 版。
   · host/memory.js  remember(title, content, category, importance, tags)；eventAppend({ source, actor, kind, content, meta })
   · host/llm.js     ask(prompt, opts) → 一段字（冷场半小时收尾用，不带工具）
   · 可选：网易云官方 ncm-cli（挑能放的版本、热评、歌词、页面上的「他在翻网易云」小提示）；ElevenLabs key（生成音效素材）。

   ── 做法里要紧的几处 ──
   ★ 歌只回 enc / ori，不在这里取地址：地址二十几分钟就过期。页面快放到这首时再去宿主的 /api/song/url 取。
   ★ 同一个台同时只做一段：页面手快连点，第二下回 409。
   ★ 放不出来：ncm-cli 走网易云开放平台，曲库比 App 小，大唱片公司的歌常是 visible:false。这里只认 visible 的版本；
     名字差一两个字也认（日文汉字 / 简体）；带歌手搜不到再光按歌名搜；一个能放的都没有就不排进去，下一段告诉他换一首；
     开播时把「试过放不出来的」整张单子给他。
     挡掉一首，就用电台这边的 ncm-cli 搜一下这个歌手，把这边能放的几首递给他（他自己查歌的那台机器看到的，跟电台这边不一定一样）；
     下一段提示里「刚放完的是」只说上一段真排进去的那首，没排进去就不说，免得他以为唱片机卡了。
     放不了的那首不悄悄拿掉：回一块 {type:'nosong', title, artist, text, ori}，text 是网易云的说法（照搜歌结果的字段翻：
     没版权 / 数字专辑 / 要会员 / 没搜到，见 whyNot），页面单子里留一行，带去网易云 App 的口子。挑版本时 playFlag=false 的也不挑。
   ★ 去重：每放一首记一笔（state.played，留三十天）。七天里放过的开播时给他；他自己挑的撞上了不排；她点的照放。
   ★ 他查网易云的时候页面要冒一句提示：看 ncm-cli 自己的日志（每个请求一行），这一段开始和结束各记一次长度，中间的请求翻成人话。
     日志里有登录换 token 的行，bizContent 绝不原样往外吐。
   ★ 音效是素材库：ElevenLabs /v1/sound-generation 生成一次存下来反复用（genSe）；湿 / 黏 / 水声用真录音（freesound CC0），垫在说话底下。
   ★ 念字：ElevenLabs 认 [whispers] 这种方括号语气（导演词的写法来自 @超未来辣椒）；落到 MiniMax 时它会照字念出来，
     所以换成它认的 (sighs)，认不得的删掉；ElevenLabs 这一句落回了 MiniMax，就换写法重念，之后二十分钟直接按 MiniMax 写。
   ★ 宿主取播放地址要是会被网易云记成「听过」（RADIO_URL_COUNTS_AS_PLAY=1），电台放过的就会混进她的「最近播放」，越放越像她爱听的。
     这时开播那句里多一段：这七天、八到三十天前电台放过的都不算她自己听的；看她口味，红心最准，其次是听歌排行。
   ★ 一首歌可以写几首候选：[song:歌名|歌手；替补|歌手；…]（最多五首）。几首一起看能不能放，按写的顺序放第一首能放、七天没放过的；
     放的不是第一首，下一段告诉他放了哪首、前面的为什么没放；全都放不了才回 nosong。
   ★ 他看不到电台这边能不能放，所以给他一个查歌工具（examples/song_check_mcp.py，调 /api/radio/check）：写串场之前先查，挑能放的说；
     候选是兜底。热评走 ncm-cli comment list-hot（--offset 必填，漏了回 400）。
   ★ 枕話单独用一个稳定度（0.75，念得稳一点），别的台照念字模块自己的设定。
   ★ 回放：每一段做完记一行进 RADIO_SITE_DIR/radio_archive/<台>.jsonl（她插的话、他念的每一句连声音、放的歌、音效），隔三小时以上算另一晚。
     念字时多要一份逐字时间（ElevenLabs 带时间戳的那条，同一次生成），每一块 say 带 align（那份声音的 hash），页面按真时间亮字、点字跳过去。
   ★ 收台（说了收台，或者冷场半小时自己收）时，让他按这一晚的记录起一个十二字以内的标题，记进 radio_archive（kind:'title'），回放单子上用；
     枕話的标题含蓄。没起成的那一晚，单子上用第一句话 / 放过的歌。
   ★ 冷场半小时自己收：每一段记进这个台的「今晚」，最后一段过去三十分钟没动静，就用一两句话收掉：
       故事 / 夜話 / 音樂 → 宿主的事件流；枕話 → 只有一句摘要进记忆，原文不进。 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { parse, TAG_RE } = require('./radio_parse.cjs');

const ROOT = process.env.RADIO_SITE_DIR || __dirname;   /* radio_state.json 放这里 */
const STATE_FILE = path.join(ROOT, 'radio_state.json');
const FZ = process.env.RADIO_DATA_DIR || path.join(__dirname, 'data');   /* 开场歌单、音效素材库、收尾用的工作目录 */
const OPENERS_FILE = path.join(FZ, 'radio_openers.json');
const TOKEN_FILE = process.env.RADIO_TOKEN_FILE || '';   /* 宿主 /api/chat/stream 要的口令放在哪个文件里（或者直接给 RADIO_TOKEN） */
const PORT = parseInt(process.env.PORT, 10) || 3000;   /* 宿主服务的端口（/api/chat/stream 在这儿） */
const TURN_TIMEOUT = 6 * 60 * 1000;   /* 他一段最多等六分钟 */
const TTS_PARALLEL = 3;

const STATIONS = {
  story:  { room: 'radio_story',  name: '故事' },
  talk:   { room: 'radio_talk',   name: '夜話' },
  music:  { room: 'radio_music',  name: '音樂' },
  pillow: { room: 'radio_pillow', name: '枕話' },
};
/* 点开先放的歌。可以写在 RADIO_DATA_DIR/radio_openers.json：{ "story": ["歌名|歌手", …], … }；文件没有就用这几首 */
const DEFAULT_OPENERS = {
  story:  ['Aqua|坂本龍一', 'Gymnopédie No.1|Erik Satie', 'Merry Christmas Mr. Lawrence|坂本龍一'],
  talk:   ['Fade Into You|Mazzy Star', '晚安|颜人中', '夜空中最亮的星|逃跑计划'],
  music:  ['夜に駆ける|YOASOBI', 'Lemon|米津玄師', '晴天|周杰伦'],
  pillow: ['Fade Into You|Mazzy Star', 'Ocean Eyes|Billie Eilish'],
};
const isStation = k => Object.prototype.hasOwnProperty.call(STATIONS, k);   /* 别让 constructor 这种名字混进来 */
const MOODS = ['宠着你', '坏一点', '吃醋', '照顾你'];
const LEVELS = ['甜', '亲密', '不收着'];

/* ── SEG:RADIO v3 · 网易云日志：他这一段在网易云上查了什么 ───────────── */
const NCM_LOG = process.env.NCM_APP_LOG || path.join(require('os').homedir(), '.config', 'ncm-cli', 'app.log');
const NCM_SKIP = /\/(?:user\/profile|cli\/manifest|oauth2|login|qrcode|play\/data)/;   /* 每次调用都会带的、跟登录有关的，不算 */
function ncmSize() { try { return fs.statSync(NCM_LOG).size; } catch (e) { return -1; } }
function ncmLabel(p, biz) {
  let b = {}; try { b = JSON.parse(biz); } catch (e) {}
  if (/\/search\//.test(p)) return b.keyword ? '搜「' + String(b.keyword).replace(/\s+/g, ' ').slice(0, 40) + '」' : '搜歌';
  if (/\/comments?\//.test(p)) return '翻评论区';
  if (/\/lyric\//.test(p)) return '看歌词';
  if (/\/recommend\//.test(p)) return '看每日推荐';
  if (/like/.test(p)) return '点了红心';
  if (/\/song\/detail\//.test(p)) return b.withUrl ? null : '看一首歌的信息';   /* withUrl = 取播放地址（页面放歌也走这个），不算 */
  if (/\/playlist\//.test(p)) return '翻歌单';
  if (/record|history|listen/.test(p)) return '翻听歌记录';
  if (/\/user\//.test(p)) return '看你的主页';
  return '查了点东西';
}
function ncmSince(from, to) {
  if (!(from >= 0)) return [];
  let end = ncmSize();
  if (end < 0) return [];
  if (to != null && to >= 0 && to < end) end = to;
  if (end <= from) return [];   /* 没新东西，或者日志被轮换了 */
  const len = Math.min(end - from, 2 * 1024 * 1024);
  const buf = Buffer.alloc(len);
  let fd = null;
  try { fd = fs.openSync(NCM_LOG, 'r'); fs.readSync(fd, buf, 0, len, from); }
  catch (e) { return []; }
  finally { if (fd !== null) try { fs.closeSync(fd); } catch (e) {} }
  const out = [];
  for (const line of buf.toString('utf8').split('\n')) {
    const m = line.match(/\[NeteaseApi\] (?:GET|POST) (\S+) bizContent=(.*)$/);   /* 只认发出去的那一行；回来的那行是「路径 → {…}」 */
    if (!m || NCM_SKIP.test(m[1])) continue;
    const l = ncmLabel(m[1], m[2]);
    if (l && out.indexOf(l) < 0) out.push(l);
  }
  return out.slice(0, 8);
}
const live = new Map();   /* 台 → { from, to }：这一段开始时 / 他说完时日志多长 */

/* ── SEG:RADIO v3 · 音效素材库 ───────────────────────────────────────
   名字跟 radio_parse 的 SE 表一一对上。prompt 照那份笔记的写法：短的写 one-shot、studio-quality、no background noise；
   「deep kiss」容易出吸溜声，用 firm kiss；拍墙写 palm slam against wall，别写 body impact（会出拳击声）。
   bed：垫在他说话底下的（雨、风、心跳），页面不等它放完。 */
const SE_DIR = path.join(FZ, 'radio_se');
const SE_LIB = {
  '轻吻': { dur: 0.6, text: 'A soft, natural kiss sound, gentle and clear, like a quick peck on the lips. Realistic and clean, with a slight lip smacking detail. Studio-quality recording with no background noise. One-shot.' },
  '亲吻': { dur: 1.2, text: 'A firm, slow kiss on the lips, very close to the microphone, soft and intimate, natural lip sound. Studio-quality recording with no background noise. One-shot.' },
  '拍墙': { dur: 0.8, text: 'Loud, sharp single palm slam against a hard wall. Forceful, sudden impact. Studio-quality recording with no background noise. One-shot.' },
  '拍打': { dur: 0.6, text: 'A single light slap of an open palm on bare skin, crisp and close. Studio-quality recording with no background noise. One-shot.' },
  '衣料': { dur: 1.0, text: 'Soft fabric rustling sound, like clothes brushing against each other. Studio-quality, clean recording. One-shot.' },
  '床单': { dur: 2.0, text: 'Cotton bed sheets rustling as someone shifts slowly on a bed, close and quiet. Studio-quality, clean recording with no background noise.' },
  '关门': { dur: 1.5, text: 'A wooden bedroom door closing gently and the latch clicking shut, indoors. Studio-quality recording with no background noise. One-shot.' },
  '脚步': { dur: 3.0, text: 'Slow footsteps on a wooden floor in a quiet room, coming closer, about five steps. Studio-quality, no background noise.' },
  '水声': { dur: 4.0, layer: true, text: 'Gentle water sounds in a bathtub, a hand moving slowly through warm water, soft small splashes, close and intimate. Studio-quality, no background noise.' },
  '湿':   { layer: true, real: true },   /* v4：真录音（freesound CC0），不生成 */
  '黏':   { layer: true, real: true },
  '心跳': { dur: 6.0, bed: true, text: 'A calm, slow human heartbeat, close and muffled, as if an ear is pressed against a chest. Clean, no background noise.' },
  '雨':   { dur: 20, bed: true, text: 'Steady soft rain on a window at night, heard from inside a quiet room, gentle and continuous. No thunder, no voices.' },
  '风':   { dur: 20, bed: true, text: 'Soft wind blowing outside a window at night, gentle gusts, heard from indoors. No other sounds.' },
};
const isSe = n => Object.prototype.hasOwnProperty.call(SE_LIB, n);
function seList() {
  const have = {};
  for (const n of Object.keys(SE_LIB)) {
    try { const st = fs.statSync(path.join(SE_DIR, n + '.mp3')); if (st.size > 512) have[n] = { v: Math.floor(st.mtimeMs), bed: !!SE_LIB[n].bed, layer: !!SE_LIB[n].layer }; } catch (e) {}
  }
  return have;
}
/* 生成一个音效存进素材库（旧的那个改名 .bak 留着）。key 跟念字同一份：环境变量 ELEVENLABS_API_KEY，没有就照 voice.json 的 el_env_file 只捞这一行 */
function elKey(c) {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
  try {
    for (const line of fs.readFileSync(c.el_env_file || '.env', 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?ELEVENLABS_API_KEY\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[1].trim(); const q = v.charAt(0);
      if ((q === '"' || q === "'") && v.charAt(v.length - 1) === q) v = v.slice(1, -1);
      if (v) return v;
    }
  } catch (e) {}
  return '';
}
function sePost(c, key, body, viaTunnel) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = https.request({
      host: viaTunnel && c.el_host ? c.el_host : 'api.elevenlabs.io',   /* 跟念字一样：配了隧道就先走隧道 */
      port: viaTunnel && c.el_port ? Number(c.el_port) : 443,
      servername: 'api.elevenlabs.io',
      path: '/v1/sound-generation?output_format=mp3_44100_128',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, 'Host': 'api.elevenlabs.io', 'Accept': 'audio/mpeg', 'xi-api-key': key },
      timeout: 90000,
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode !== 200) { const e = new Error('ElevenLabs 回 ' + res.statusCode + '：' + buf.toString('utf8').slice(0, 200)); e.http = true; return reject(e); }
        if (buf.length < 512) return reject(new Error('音频太短（' + buf.length + 'B）'));
        resolve(buf);
      });
    });
    req.on('timeout', () => req.destroy(new Error('九十秒没回')));
    req.on('error', reject);
    req.end(payload);
  });
}
let sePostImpl = sePost;   /* 单测换成假的 */
async function genSe(name) {
  if (!isSe(name)) throw new Error('音效表里没有「' + name + '」');
  if (SE_LIB[name].real) throw new Error('「' + name + '」用真录音，不生成（安装脚本 --use-se）');
  const c = tts().cfg ? tts().cfg() : {};
  const key = elKey(c);
  if (!key) throw new Error('找不到 ElevenLabs 的 key');
  const it = SE_LIB[name];
  const body = { text: it.text, duration_seconds: it.dur, prompt_influence: 0.6 };
  let buf;
  try { buf = await sePostImpl(c, key, body, true); }
  catch (e) { if (e.http || !c.el_host) throw e; buf = await sePostImpl(c, key, body, false); }   /* 隧道抽风就直连再试一次 */
  fs.mkdirSync(SE_DIR, { recursive: true });
  const file = path.join(SE_DIR, name + '.mp3');
  if (fs.existsSync(file)) fs.renameSync(file, file + '.bak');
  fs.writeFileSync(file, buf);
  return { name, bytes: buf.length, file };
}

let _memory = null, _tts = null;
const memory = () => _memory || (_memory = require('./host/memory'));
const tts = () => _tts || (_tts = require('./host/tts'));
const HOST_NAME = process.env.RADIO_HOST_NAME || '冥河';   /* 主持人的名字：收尾那句去掉「冥河：」这种前缀；事件流里记是谁 */
const urlCountsAsPlay = () => /^(1|true|yes|on)$/i.test(String(process.env.RADIO_URL_COUNTS_AS_PLAY || ''));   /* 宿主取播放地址会不会被网易云记成「听过」 */

/* ── SEG:RADIO v10 · 歌词（她 10-19：「要不要做滚动歌词啊」）───────────────
   宿主歌卡那个歌词接口把时间戳去掉了 —— 那边是整段显示用的。滚动要时间，这里自己再取一次：
   ncm-cli song lyric --songId <加密id>，跟歌卡取歌词同一条命令；原文、翻译都是带 [mm:ss.xx] 的 LRC，按时间对上。
   回 { pure, lines: [{ t: 秒, x: 原文, tr: 翻译（有才带）}] }。作词作曲那几行去掉；没有时间戳的当没歌词（页面就不滚）。
   一次开机里记 200 首；ncm-cli 挂了不记，下回再取。 */
function ncmLyricCli(enc) {
  return new Promise(resolve => {
    execFile('ncm-cli', ['song', 'lyric', '--songId', String(enc), '--output', 'json'],
      { timeout: 20000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        if (err) return resolve(null);
        const s = String(out || ''); const i = s.indexOf('{');
        try { resolve(JSON.parse(i > 0 ? s.slice(i) : s)); } catch (e) { resolve(null); }
      });
  });
}
let lyricImpl = ncmLyricCli;   /* 单测换成假的 */
const LRC_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const CREDIT = /^(作词|作曲|编曲|制作人|监制|混音|母带|和声|录音|吉他|贝斯|鼓|弦乐|钢琴|出品|发行|OP|SP|词|曲|Lyrics?|Composer|Arranger|Producer)\s*[:：]/i;
function parseLrc(s) {
  const out = [];
  for (const raw of String(s || '').split(/\r?\n/)) {
    const tags = [...raw.matchAll(LRC_TAG)];
    if (!tags.length) continue;
    const x = raw.replace(LRC_TAG, '').trim();
    for (const m of tags) out.push({ t: (+m[1]) * 60 + (+m[2]) + (m[3] ? parseFloat('0.' + m[3]) : 0), x });
  }
  return out.sort((a, b) => a.t - b.t);
}
function buildLyric(d) {
  const b = (d && d.data) || {};
  if (b.pureMusic || b.noLyric) return { pure: true, lines: [] };
  const main = parseLrc(b.lyric).filter(l => l.x && !CREDIT.test(l.x));
  const tr = parseLrc(b.transLyric).filter(l => l.x);
  const lines = main.slice(0, 300).map(l => {
    const m = tr.find(r => Math.abs(r.t - l.t) < 0.06);
    const o = { t: Math.round(l.t * 100) / 100, x: l.x.slice(0, 120) };
    if (m && m.x !== l.x) o.tr = m.x.slice(0, 120);
    return o;
  });
  return { pure: false, lines };
}
const lyricMemo = new Map();
async function getLyricTimed(enc) {
  enc = String(enc || '').trim();
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(enc)) return { pure: false, lines: [] };
  if (lyricMemo.has(enc)) return lyricMemo.get(enc);
  const d = await lyricImpl(enc);
  if (!d) return { pure: false, lines: [] };
  const v = buildLyric(d);
  lyricMemo.set(enc, v);
  if (lyricMemo.size > 200) lyricMemo.delete(lyricMemo.keys().next().value);
  return v;
}

/* ── 搜一首「能放的」：ncm-cli 搜，只认 visible:true 的版本（v10：名字差一两个字也认、带歌手搜不到再光按歌名搜） ── */
function ncmSearchCli(kw, limit) {
  return new Promise(resolve => {
    execFile('ncm-cli', ['search', 'song', '--keyword', kw, '--limit', String(limit || 8), '--output', 'json'],
      { timeout: 20000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        if (err) return resolve(null);
        const s = String(out || ''); const i = s.indexOf('{');
        try { resolve(JSON.parse(i > 0 ? s.slice(i) : s)); } catch (e) { resolve(null); }
      });
  });
}
let searchImpl = ncmSearchCli;   /* 单测换成假的 */
/* SEG:RADIO v19 —— 热评：ncm-cli comment list-hot（规矩里一直让他自己翻，这回由电台这边翻好递给他） */
function ncmHotCli(enc) {
  return new Promise(resolve => {
    execFile('ncm-cli', ['comment', 'list-hot', '--type', 'song', '--resourceId', String(enc), '--limit', '10', '--offset', '0', '--output', 'json'],   /* v20：--offset 也是必填，漏了就回 400 */
      { timeout: 20000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        if (err) return resolve(null);
        const s = String(out || ''); const i = s.indexOf('{');
        try { resolve(JSON.parse(i > 0 ? s.slice(i) : s)); } catch (e) { resolve(null); }
      });
  });
}
let hotImpl = ncmHotCli;   /* 单测换成假的 */
function pickHot(d) {
  const b = (d && d.data) || d || {};
  const list = [b.hotComments, b.comments, b.records, b.list, Array.isArray(b) ? b : null].find(x => Array.isArray(x) && x.length) || [];
  return list.map(c => ({ text: String((c && (c.content || c.text)) || '').replace(/\s+/g, ' ').trim().slice(0, 200), likes: Number((c && (c.likedCount || c.likeCount)) || 0) }))
    .filter(c => c.text).slice(0, 5);
}
const norm = s => String(s || '').toLowerCase().replace(/[\s'’"“”()（）\[\]【】\-—–_.,，。!！?？]/g, '');
const PLAY_TTL = 3 * 24 * 3600 * 1000;   /* 「这首放不了」记三天，三天后再试 */
const playMemo = new Map();               /* 这一次开机里搜过的：'歌名|歌手' → 结果 */
/* SEG:RADIO v10 —— 名字差一两个字也认：日文汉字跟简体（久石譲 / 久石让、米津玄師 / 米津玄师）。
   一边包含另一边照旧算；再加一条：带汉字、一样长、头一个字一样、同一位置上六成以上的字一样。 */
function near(a, b) {
  if (!a || !b) return false;
  if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return true;
  const A = [...a], B = [...b];
  if (A.length !== B.length || A.length < 2 || A[0] !== B[0] || !/[㐀-鿿]/.test(a + b)) return false;
  let same = 0;
  for (let i = 0; i < A.length; i++) if (A[i] === B[i]) same++;
  return same / A.length >= 0.6;
}
/* SEG:RADIO v12 —— 放不了的原因，照网易云「歌曲无法播放 toast 文案」那张表翻（不另调那个接口：搜歌结果里字段都有） */
const recsOf = d => (d && d.data && d.data.records) || [];
function whyNot(recs, artOk, nameOk) {
  const r = recs.find(x => x && x.name && nameOk(x) && artOk(x));
  if (!r) return { why: 'notfound', text: '网易云上没搜到这一首' };
  const o = { ori: String(r.originalId || '') };
  if (r.visible === false) return Object.assign(o, { why: 'nocopy', text: '因合作方要求，暂不支持收听' });
  if (r.songFee === 4) return Object.assign(o, { why: 'album', text: '数字专辑，要在手机端购买' });
  if (r.vipFlag || r.vipPlayFlag || r.payPlayFlag) return Object.assign(o, { why: 'vip', text: 'VIP 歌曲，要开通会员' });
  return Object.assign(o, { why: 'other', text: '暂时放不了' });
}
async function findPlayable(title, artist, cache, info) {
  title = String(title || '').trim(); artist = String(artist || '').trim();
  if (!title) return null;
  const key = title + '|' + artist;
  const hit = playMemo.get(key) || (cache && cache[key]);
  if (hit && (hit.enc || Date.now() - (hit.at || 0) < PLAY_TTL)) { if (!hit.enc && info) info.bad = hit; return hit.enc ? hit : null; }
  const nt = norm(title), na = norm(artist);
  const artOk = r => !na || (r.artists || []).some(a => near(norm(a && a.name), na));
  const nameOk = r => near(norm(r.name), nt);
  const choose = d => {
    const ok = recsOf(d).filter(r => r && r.visible === true && r.playFlag !== false && r.id);   /* v12：playFlag=false 的也不挑 */
    return ok.find(r => artOk(r) && nameOk(r)) || (na ? null : ok.find(nameOk)) || null;
  };
  const data = await searchImpl(artist ? artist + ' ' + title : title, 12);
  let pick = choose(data), data2 = null;
  /* v10：带着歌手搜，前十二条里没有能放的 —— 再光按歌名搜二十条（歌手名写法不一样的，带着搜常常排不到前面） */
  if (!pick && data && artist) { data2 = await searchImpl(title, 20); pick = choose(data2); }
  let v;
  if (pick) {
    v = { title: pick.name || title, artist: (pick.artists || []).map(a => a && a.name).filter(Boolean).join(' / ') || artist,
          enc: pick.id, ori: String(pick.originalId || ''), cover: String(pick.coverImgUrl || '').replace(/^http:\/\//, 'https://') };
  } else v = data ? Object.assign({ bad: true, at: Date.now() }, whyNot(recsOf(data).concat(recsOf(data2)), artOk, nameOk)) : null;   /* 搜都没搜成（cli 挂了）就不记成「放不了」 */
  if (!data && info) info.failed = true;
  if (v) { playMemo.set(key, v); if (cache) cache[key] = v; }
  if (v && v.bad && info) info.bad = v;
  return v && v.enc ? v : null;
}

/* SEG:RADIO v11 —— 一首放不了：这个歌手在电台这边能放的有哪几首。他自己查歌的那台机器看到的，跟这边不一定一样，所以由这边告诉他。
   一次开机里每个歌手只搜一次；搜不成（cli 挂了）就不给。 */
const artistMemo = new Map();
async function playableByArtist(artist, except) {
  artist = String(artist || '').split(/\s*[\/、,&，]\s*/)[0].trim();
  if (!artist) return [];
  const na = norm(artist);
  let names = artistMemo.get(na);
  if (!names) {
    const d = await searchImpl(artist, 20);
    if (!d) return [];
    names = [];
    for (const r of ((d.data && d.data.records) || [])) {
      if (!r || r.visible !== true || !r.name) continue;
      if (!(r.artists || []).some(a => near(norm(a && a.name), na))) continue;
      const t = String(r.name).replace(/\s*[（(][^）)]*[）)]\s*$/, '').trim();
      if (t && names.indexOf(t) < 0) names.push(t);
      if (names.length >= 6) break;
    }
    artistMemo.set(na, names);
    if (artistMemo.size > 100) artistMemo.delete(artistMemo.keys().next().value);
  }
  return names.filter(n => norm(n) !== norm(except)).slice(0, 5);
}

/* ── SEG:RADIO v10 · 最近放过的别再放（她 10-19：「是不是应该加去重 最近放过的就不要再放了」）───────
   state.played：每放一首记一笔 { id, title, artist, enc, ori, cover, st, at }，留三十天、最多三百条。
   「同一首」：编号一样，或者歌名（去掉括号里的 Live 之类）+ 第一个歌手一样。 */
const RECENT_DAYS = 7, PLAYED_KEEP_DAYS = 30, PLAYED_MAX = 300;
const songId = (title, artist) => norm(String(title || '').replace(/[（(\[【][^）)\]】]*[）)\]】]/g, '')) + '|' + norm(String(artist || '').split(/\s*[\/、,&，]\s*/)[0]);
function recentPlayed(state) {
  const since = Date.now() - RECENT_DAYS * 864e5;
  return (state.played || []).filter(p => p && p.at >= since);
}
function playedMatch(state, v, list) {
  const id = songId(v.title, v.artist);
  return (list || state.played || []).filter(p => p && ((v.enc && p.enc === v.enc) || p.id === id));
}
const wasRecent = (state, v) => playedMatch(state, v, recentPlayed(state)).pop() || null;
const lastPlayedAt = (state, v) => playedMatch(state, v).reduce((m, p) => Math.max(m, p.at || 0), 0);
function notePlayed(state, v, key) {
  if (!v || !v.title) return;
  const list = (state.played || []).concat([{ id: songId(v.title, v.artist), title: String(v.title).slice(0, 80), artist: String(v.artist || '').slice(0, 80),
    enc: v.enc || '', ori: String(v.ori || ''), cover: v.cover || '', st: key, at: Date.now() }]);
  const old = Date.now() - PLAYED_KEEP_DAYS * 864e5;
  state.played = list.filter(p => p && p.at >= old).slice(-PLAYED_MAX);
}
/* 开播时给他的单子：七天里放过的（新的在前，同一首只写一次，最多四十首）、试过放不出来的（三天里，最多十五首）
   v13：再加八到三十天前电台放过的（最多三十首）—— 不拦他点，翻她听歌记录的时候用来剔 */
function songLists(state) {
  const seen = new Set(), recent = [], older = [];
  const fmt = p => '《' + p.title + '》' + (p.artist ? p.artist.split(/\s*\/\s*/)[0] : '');
  for (const p of recentPlayed(state).slice().reverse()) {
    if (seen.has(p.id)) continue; seen.add(p.id);
    recent.push(fmt(p));
    if (recent.length >= 40) break;
  }
  const since7 = Date.now() - RECENT_DAYS * 864e5, since30 = Date.now() - PLAYED_KEEP_DAYS * 864e5;
  for (const p of (state.played || []).slice().reverse()) {
    if (!p || !p.title || p.at >= since7 || p.at < since30 || seen.has(p.id)) continue;
    seen.add(p.id);
    older.push(fmt(p));
    if (older.length >= 30) break;
  }
  const bad = Object.entries(state.playCache || {})
    .filter(([k, v]) => v && v.bad && Date.now() - (v.at || 0) < PLAY_TTL)
    .sort((a, b) => b[1].at - a[1].at).slice(0, 15)
    .map(([k]) => { const i = k.indexOf('|'); return '《' + (i < 0 ? k : k.slice(0, i)) + '》' + (i < 0 ? '' : k.slice(i + 1)); });
  return { recent, older, bad };
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } }
function writeJson(f, v) { const tmp = f + '.tmp' + process.pid; fs.writeFileSync(tmp, JSON.stringify(v, null, 2)); fs.renameSync(tmp, f); }
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > max) { reject(new Error('太长了')); req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(new Error('不是 JSON')); } });
    req.on('error', reject);
  });
}
function nowText() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}
function token() { if (process.env.RADIO_TOKEN) return process.env.RADIO_TOKEN; try { return TOKEN_FILE ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : ''; } catch (e) { return ''; } }

/* ── 状态：每个台一格，存在站点目录 radio_state.json ───────────────── */
function loadState() { const s = readJson(STATE_FILE, {}); s.stations = s.stations || {}; return s; }
function stOf(state, key) { return state.stations[key] || (state.stations[key] = {}); }

/* ── 让他在这个台的会话里做一段：本机打一次 /api/chat/stream ───────────────── */
function chatTurn(room, message) {
  return new Promise((resolve, reject) => {
    const uid = 'radio_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    const body = JSON.stringify({ message, room, via: 'radio', parts: [{ content: message, ts: Date.now(), _uid: uid }] });
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    const tk = token(); if (tk) headers['X-Radio-Token'] = tk;
    const bubbles = [];
    let err = '', buf = '', settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/chat/stream', method: 'POST', headers }, res => {
      if (res.statusCode !== 200) { res.resume(); return finish(reject, new Error('宿主回 ' + res.statusCode)); }
      res.setEncoding('utf8');
      res.on('data', c => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          let ev = 'message', data = '';
          for (const line of block.split('\n')) {
            if (line.indexOf('event:') === 0) ev = line.slice(6).trim();
            else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
          }
          if (!data) continue;
          let o = null; try { o = JSON.parse(data); } catch (e) { continue; }
          if (ev === 'bubble' && o && typeof o.text === 'string') bubbles.push(o.text);
          else if (ev === 'error' && o && o.text) err = String(o.text);
        }
      });
      res.on('end', () => {
        if (!bubbles.length && err) return finish(reject, new Error(err));
        finish(resolve, { text: bubbles.join('\n\n'), error: err });
      });
      res.on('error', e => finish(reject, e));
    });
    const timer = setTimeout(() => { req.destroy(); finish(reject, new Error('他这一段六分钟还没说完')); }, TURN_TIMEOUT);
    req.on('error', e => finish(reject, e));
    req.end(body);
  });
}

/* ── 发给他的那句提示 ─────────────────────────────────────────────── */
function compose(key, kind, text, order, st, opener, texts, lists) {
  const t = String(text || '').trim().slice(0, 1000);
  /* SEG:RADIO v5 —— 一批纸条：编号一起给他 */
  const many = Array.isArray(texts) ? texts.map(x => String(x || '').trim().slice(0, 500)).filter(Boolean).slice(0, 12) : [];
  /* SEG:RADIO v2 —— 上一段他点的歌这边放不了：告诉他，换一首 */
  /* v11：放不了的那首，这个歌手在这边能放的几首一起递给他 */
  const alt = (st.unplayableAlt || []).filter(a => a && a.artist && a.songs && a.songs.length).map(a => a.artist + '在这边能放的：《' + a.songs.join('》《') + '》').join('；');
  /* v12：网易云的说法（没版权 / 要会员 / 数字专辑）一起告诉他 */
  const whyMap = st.unplayableWhy || {};
  const whyTxt = (st.unplayable || []).filter(t => whyMap[t]).map(t => '《' + t + '》' + whyMap[t]).join('；');
  const miss = ((st.unplayable && st.unplayable.length) ? '\n（上一段你点的《' + st.unplayable.join('》《') + '》在这边放不出来，网易云没有能放的版本。' + (whyTxt ? '网易云的说法：' + whyTxt + '。' : '') + '下次换一首别的。' + (alt ? alt + '。' : '') + '）' : '')
    /* SEG:RADIO v10 —— 他自己挑的撞上了七天里放过的：没放，告诉他 */
    + ((st.repeated && st.repeated.length) ? '\n（上一段你挑的《' + st.repeated.join('》《') + '》这几天刚放过，这回没放。换一首没放过的。）' : '')
    /* SEG:RADIO v18 —— 候选里放的不是第一首：告诉他放了哪首、前面的为什么没放 */
    + (st.swapped || []).map(w => '\n（上一段你写的候选里，' + w.skip.map(x => '《' + x.title + '》' + (x.why ? '（' + x.why + '）' : '')).join('') + '没放，放的是《' + w.got + '》。接着说的时候按这首来。）').join('');
  if (kind === 'her') return '[电台·热线] ' + t + miss;
  if (kind === 'memo' && many.length > 1) return '[电台·纸条] 这一段攒了 ' + many.length + ' 张纸条，一起念：\n' + many.map((x, i) => (i + 1) + '. ' + x).join('\n') + miss;
  if (kind === 'memo') return '[电台·纸条] ' + (many[0] || t) + miss;
  if (kind === 'req') return '[电台·点歌] ' + t + miss;
  if (kind === 'bye') return '[电台·收台]';
  /* v11：只说上一段真排进去的那首；上一段没排进歌就不说（以前拿 lastSong，三天前那首会一直被说成「刚放完」） */
  if (kind === 'next') return '[电台·下一段]' + (st.segSong ? '\n刚放完的是《' + st.segSong.title + '》' + (st.segSong.artist ? '（' + st.segSong.artist + '）' : '') + '。' : '') + miss;
  /* open */
  const lines = ['[电台·开播] 现在是 ' + nowText() + '。'];
  if (opener) lines.push('开场先放了一首《' + opener.title + '》' + (opener.artist ? '（' + opener.artist + '）' : '') + '，这首放完轮到你。');
  if (key === 'story') {
    if (st.bible) {
      lines.push('', '本子：', st.bible);
      if (st.tail) lines.push('', '上回讲到这里：', st.tail);
    } else lines.push('还没有在讲的故事，今晚开一个新的，先写本子。');
  } else if (key === 'talk' || key === 'music') {
    if (st.tail) lines.push('', '上回最后说的是：', st.tail);
  } else if (key === 'pillow') {
    const o = order || {};
    const scene = String(o.scene || '').trim().slice(0, 200) || '随机';
    const mood = MOODS.indexOf(o.mood) >= 0 ? o.mood : '宠着你';
    const level = LEVELS.indexOf(o.level) >= 0 ? o.level : '甜';
    lines.push('点单：情境＝' + scene + '；他今晚＝' + mood + '；尺度＝' + level + '。');
    lines.push('先写今晚的 <轨道>，再从第一轨开始。');
  }
  /* SEG:RADIO v10 —— 两张单子：别点放过的、别点放不出来的 */
  if (lists && lists.recent && lists.recent.length) lines.push('', '这七天电台放过的（别再点，换没放过的）：' + lists.recent.join('、'));
  if (lists && lists.bad && lists.bad.length) lines.push('', '试过、网易云这边放不出来的（别点）：' + lists.bad.join('、'));
  /* SEG:RADIO v13 —— 让他翻她的听歌记录时分清哪些是电台放的。只在宿主取播放地址会被网易云记成「听过」时才说（RADIO_URL_COUNTS_AS_PLAY=1）：
     那样电台放过的会混进她的「最近播放」，越放越像她爱听的。 */
  const rh = !!(lists && lists.recent && lists.recent.length), oh = !!(lists && lists.older && lists.older.length);
  if (urlCountsAsPlay() && (rh || oh)) lines.push('', '翻她的听歌记录时分清：电台放的歌，网易云多半会记成她听过（取播放地址那一下记的）。'
    + (rh ? '上面这七天电台放过的' : '') + (rh && oh ? '，还有' : '') + (oh ? '更早电台放过的' + lists.older.join('、') : '')
    + ' —— 都是电台放的，不是她自己点开听的，别当成她的口味，也别说成「你最近老听」。看她爱听什么，红心最准（只有她自己会点），其次是听歌排行。');
  return lines.join('\n');
}

/* ── 念：每块 say 交给 host/tts，两块两块地并着念 ─────────────────── */
/* SEG:RADIO v5 —— 念给 MiniMax 的写法：它认的语气换成圆括号（host/tts 再按型号决定留不留），认不得的去掉 */
const MM_TAG = { 'sighs': '(sighs)', 'chuckles': '(chuckle)', 'breathing heavily': '(pant)', 'shaky breath': '(inhale)' };
const forMiniMax = t => String(t || '').replace(/\[([a-z][a-z ,']*)\]\s*/g, (m, g) => MM_TAG[g] ? MM_TAG[g] + ' ' : '').trim();
let elDownUntil = 0;
function elOn() {
  try { const c = tts().cfg ? tts().cfg() : {}; return String(c.provider || '').toLowerCase() === 'elevenlabs' && !!c.el_voice_id; }
  catch (e) { return false; }
}
/* SEG:RADIO v14 —— 枕話单独用一个稳定度，念得稳一点。只给枕話；念字模块不收这个数就照它自己的设定念 */
const PILLOW_STABILITY = 0.75;
async function synthAll(parts, opt) {
  const says = parts.filter(p => p.type === 'say');
  let i = 0;
  const worker = async () => {
    while (i < says.length) {
      const p = says[i++];
      try {
        const useEl = elOn() && Date.now() > elDownUntil;
        const mm = forMiniMax(p.text);
        let r = await tts().synth(useEl ? p.text : mm, useEl ? opt : undefined);
        if (useEl && r && r.hash && r.via !== 'ElevenLabs' && mm !== p.text) {
          /* 选的是 ElevenLabs，这一句却落回了 MiniMax（多半是没额度了）：方括号会被照字念，换写法重念 */
          elDownUntil = Date.now() + 20 * 60000;
          console.warn('[radio] ElevenLabs 这句没念成、落到了 MiniMax，二十分钟内电台按 MiniMax 的写法送');
          r = await tts().synth(mm);
        }
        if (r && r.hash) p.audio = '/api/tts/' + r.hash + '.mp3';
        else p.ttsErr = (r && r.skipped) || '没拿到音频';
        if (r && r.hash && r.align) p.align = r.hash;   /* v15：这一句有逐字时间 */
      } catch (e) { p.ttsErr = (e && e.message) || String(e); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(TTS_PARALLEL, says.length) }, worker));
}

/* ── 点开先放的那首 ───────────────────────────────────────────────── */
function openersFor(key) {
  const f = readJson(OPENERS_FILE, null);
  const list = (f && Array.isArray(f[key]) && f[key].length) ? f[key] : DEFAULT_OPENERS[key];
  return list.map(String).filter(Boolean);
}
async function pickOpener(key, state) {
  const st = stOf(state, key);
  delete state.songCache;   /* v1 的缓存不看能不能放，作废 */
  const cache = state.playCache || (state.playCache = {});
  const list = openersFor(key);
  /* SEG:RADIO v10 —— 七天里放过的先不放。单子里那几首之外，这个台以前放过、能放的也算进来；
     都放过了，挑最久没放的那首（以前是「上回开场那首先别放」，三首里两首放不了的台，天天开场都是同一首） */
  const seen = new Set();
  const hist = (state.played || []).slice().reverse().filter(p => p && p.st === key && p.enc && !seen.has(p.id) && seen.add(p.id));
  const order = list.map(line => ({ line })).concat(hist.map(h => ({ h }))).sort(() => Math.random() - .5);
  const tired = [];
  for (const c of order) {
    let v;
    if (c.line) { const [title, artist] = c.line.split('|').map(s => (s || '').trim()); v = await findPlayable(title, artist, cache); }
    else v = { title: c.h.title, artist: c.h.artist, enc: c.h.enc, ori: c.h.ori, cover: c.h.cover };
    if (!v) continue;
    if (!wasRecent(state, v)) { if (c.line) st.lastOpener = c.line; return v; }
    tired.push({ v, line: c.line, at: lastPlayedAt(state, v) });
  }
  if (tired.length) {
    tired.sort((a, b) => a.at - b.at);
    if (tired[0].line) st.lastOpener = tired[0].line;
    return tired[0].v;
  }
  /* 一首能放的都没有：拿他上回在这个台点过的歌顶上（那首是核过能放的） */
  return st.lastSong || null;
}

/* ── SEG:RADIO v4 · 冷场半小时自己收 ───────────────────────────────── */
const IDLE_MIN = 30;
const NIGHT_MAX = 40;   /* 一晚最多记几段（太长的只留最后这些） */
const DIGEST_WORKDIR = path.join(FZ, 'radio_workdir');
let askImpl = (prompt) => {
  try { fs.mkdirSync(DIGEST_WORKDIR, { recursive: true }); } catch (e) {}
  return require('./host/llm').ask(prompt, { cwd: DIGEST_WORKDIR, timeout: 120000, extraArgs: ['--tools', ''] });   /* 不带工具 */
};
const hm = t => new Date(t).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
const md = t => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(5);
function noteNight(st, kind, body, out) {
  const n = st.night || (st.night = { from: Date.now(), lines: [] });
  const line = { t: Date.now(), kind };
  if (kind === 'her' || kind === 'memo' || kind === 'req') line.her = String(body.text || '').trim().slice(0, 300);
  if (out.plain) line.say = out.plain.replace(/\s+/g, ' ').slice(0, 300);
  const songs = out.parts.filter(p => p.type === 'song').map(p => p.title + (p.artist ? ' — ' + p.artist : ''));
  if (songs.length) line.songs = songs;
  if (out.dropped && out.dropped.length) line.dropped = out.dropped.slice(0, 5);   /* v11：没排进去的（放不了 / 刚放过），以后查得到 */
  n.lines.push(line);
  if (n.lines.length > NIGHT_MAX) n.lines.splice(0, n.lines.length - NIGHT_MAX);
}
function nightText(n) {
  const HER = { her: '她（热线）', memo: '她（纸条）', req: '她（点歌）' };
  const out = [];
  for (const l of n.lines) {
    if (l.her) out.push('[' + hm(l.t) + '] ' + HER[l.kind] + '：' + l.her);
    if (l.say) out.push('[' + hm(l.t) + '] 你：' + l.say);
    (l.songs || []).forEach(x => out.push('[' + hm(l.t) + '] ♪ ' + x));
  }
  return out.join('\n');
}
function digestPrompt(key, n, st) {
  if (key === 'pillow') {
    const o = st.order || {};
    return '下面是今晚枕話台的记录（点单：情境＝' + (o.scene || '随机') + '；他今晚＝' + (o.mood || '') + '；尺度＝' + (o.level || '') + '）。'
      + '她听着听着没再出声，台就停在这儿了。\n'
      + '写一两句只给你自己记着的摘要：今晚的情境、她明显喜欢的、她喊停或者不喜欢的。不复述露骨的细节，第一人称，不加前缀，只输出这一两句。\n\n'
      + nightText(n);
  }
  return '下面是她今晚在家里的深夜电台「' + STATIONS[key].name + '」台听的记录。你是主持人；「她」那几行是她插的话，「你」是你念的，「♪」是放的歌。\n'
    + '用一两句话给家里的时间线记一笔：什么时候、听了什么（故事讲到哪 / 聊了什么 / 放了哪几首）、她说了什么。第一人称，平实，别升华，别加前缀，只输出这一两句。\n\n'
    + nightText(n);
}
/* SEG:RADIO v16 —— 回放单子上每一晚一个标题，收台的时候自动写。
   收台（说了收台，或者冷场半小时自己收）时，拿这一晚的记录让他起一个短标题，记进 radio_archive（kind:'title'），回放单子用它；
   没起成的那一晚，单子上照旧用第一句话 / 放过的歌。枕話的标题含蓄，不露骨。 */
function titlePrompt(key, n) {
  return '下面是今晚深夜电台「' + STATIONS[key].name + '」台的记录。给这一晚起一个标题，像节目单上的一行：'
    + '从今晚真讲到的、放到的、她说到的东西里来，具体，别用「深夜」「温柔」「晚安」这种空词，十二个字以内，不要书名号、引号、句号。'
    + (key === 'pillow' ? '这是枕話台：标题含蓄一点，不写露骨的词，不复述露骨的细节，别人看到也没关系。' : '')
    + '只输出标题这一行。\n\n' + nightText(n);
}
function cleanTitle(s) {
  let t = String(s || '').trim().split('\n').map(x => x.trim()).filter(Boolean)[0] || '';
  t = t.replace(new RegExp('^' + HOST_NAME + '\\s*[:：]\\s*'), '').replace(/^标题\s*[:：]\s*/, '').replace(/[《》「」『』"“”'‘’]/g, '').replace(/[。．.！!]+$/, '').trim();
  if (!t || /hit your (session|usage) limit|tool_calls|antml:/i.test(t)) return '';
  return [...t].slice(0, 16).join('');
}
async function nightTitle(key, n) {
  try {
    if (!n || !Array.isArray(n.lines) || !n.lines.length) return '';
    const t = cleanTitle(await askImpl(titlePrompt(key, n)));
    if (!t) return '';
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    fs.appendFileSync(archFile(key), JSON.stringify({ t: Date.now(), kind: 'title', title: t, parts: [] }) + '\n');
    return t;
  } catch (e) { console.warn('[radio] ' + key + ' 这一晚的标题没起成：' + (e && e.message)); return ''; }
}
const digesting = new Set();
async function digest(key, force) {
  if (digesting.has(key) || busy.has(key)) return false;
  const st0 = stOf(loadState(), key);
  const n = st0.night;
  if (!n || !Array.isArray(n.lines) || !n.lines.length) return false;
  const last = n.lines[n.lines.length - 1].t;
  if (!force && Date.now() - last < IDLE_MIN * 60000) return false;
  digesting.add(key);
  let ok = false;
  try {
    let s = String(await askImpl(digestPrompt(key, n, st0)) || '').trim().replace(new RegExp('^' + HOST_NAME + '\\s*[:：]\\s*'), '');
    if (!s || /hit your (session|usage) limit|tool_calls|antml:/i.test(s)) throw new Error('收出来是空的 / 不像话');
    s = s.slice(0, 300);
    if (key === 'pillow') {
      const o = st0.order || {};
      await memory().remember('枕話 · ' + md(n.from), s + (o.scene ? '\n（情境：' + o.scene + '；' + (o.mood || '') + '；' + (o.level || '') + '）' : ''), '电台', 2, 'radio,枕話');
    } else {
      memory().eventAppend({ source: 'radio', actor: HOST_NAME, kind: 'radio', content: '电台·' + STATIONS[key].name + '：' + s, meta: { station: key, from: n.from, to: last, n: n.lines.length } });
    }
    ok = true;
    console.log('[radio] ' + key + ' 冷场收了一句（' + n.lines.length + ' 段 → 1）');
    await nightTitle(key, n);   /* v16：顺手给这一晚起个标题，回放单子上用 */
  } catch (e) {
    console.warn('[radio] ' + key + ' 收尾没成：' + (e && e.message));
  } finally {
    /* 收过的清掉（收的时候又来了新的一段就留着新的）；没收成记一次，三次都不成就算了，免得每五分钟问一遍 */
    const fresh = loadState(); const f2 = stOf(fresh, key);
    if (f2.night) {
      if (ok || (f2.night.fail = (f2.night.fail || 0) + 1) >= 3) {
        f2.night.lines = (f2.night.lines || []).filter(l => l.t > last);
        if (!f2.night.lines.length) delete f2.night; else { f2.night.from = f2.night.lines[0].t; delete f2.night.fail; }
        if (key === 'pillow' && !f2.night) { f2.tracks = null; f2.trackNo = null; }
      }
      if (ok) f2.lastDigestAt = Date.now();
      writeJson(STATE_FILE, fresh);
    }
    digesting.delete(key);
  }
  return ok;
}
async function sweep() { for (const key of Object.keys(STATIONS)) { try { await digest(key, false); } catch (e) {} } }
let idleT = null;
function startIdle() {
  if (idleT) return;
  idleT = setInterval(() => { sweep().catch(() => {}); }, 5 * 60 * 1000);
  if (idleT.unref) idleT.unref();
}

/* ── 一段：开播 / 下一段 / 插话 ───────────────────────────────────── */
const busy = new Set();
async function turn(body) {
  const key = String(body.station || '');
  const S = isStation(key) ? STATIONS[key] : null;
  if (!S) return { code: 400, obj: { error: '没有这个台：' + key } };
  const kind = String(body.kind || 'next');
  if (['open', 'next', 'her', 'memo', 'req', 'bye'].indexOf(kind) < 0) return { code: 400, obj: { error: 'kind 不认识：' + kind } };
  if (kind === 'memo' && Array.isArray(body.texts) && !body.text) body.text = body.texts.map(x => String(x || '').trim()).filter(Boolean).join('\n');
  if ((kind === 'her' || kind === 'memo' || kind === 'req') && !String(body.text || '').trim()) return { code: 400, obj: { error: '她那句是空的' } };
  if (busy.has(key)) return { code: 409, obj: { error: '这个台上一段还没做完', busy: true } };
  busy.add(key);
  const t0 = Date.now();
  try {
    const state = loadState();
    const st = stOf(state, key);
    const opener = kind === 'open' && body.opener && body.opener.title ? { title: String(body.opener.title).slice(0, 80), artist: String(body.opener.artist || '').slice(0, 80) } : null;
    const message = compose(key, kind, body.text, body.order, st, opener, kind === 'memo' ? body.texts : null,
      kind === 'open' && key !== 'pillow' ? songLists(state) : null);   /* v10：开播带两张单子 */
    const lv = { from: ncmSize(), to: null };
    live.set(key, lv);
    const r = await chatTurn(S.room, message);
    lv.to = ncmSize();   /* 他说完了；后面电台自己核歌能不能放也会调网易云，那不算他的 */
    const ncm = ncmSince(lv.from, lv.to);
    const out = parse(r.text, { pillow: key === 'pillow' });

    /* SEG:RADIO v2 —— 他点的歌：换成能放的那个版本；一个能放的都没有就不排进去，下一段告诉他 */
    const s0 = loadState();
    const cache0 = s0.playCache || {};
    const missed = [], repeated = [], alts = [], why = {};
    /* SEG:RADIO v10 —— 他自己挑的（开播 / 下一段）撞上七天里放过的，不排；她点歌、热线、纸条里要的照放 */
    const noRepeat = kind === 'open' || kind === 'next';
    const swapped = [];
    for (const p of out.parts.filter(x => x.type === 'song')) {
      /* SEG:RADIO v18 —— 几首候选同时去看能不能放，按他写的顺序挑第一首能放的、七天里没放过的 */
      const cands = [{ title: p.title, artist: p.artist }].concat(p.alts || []).slice(0, 5);
      delete p.alts;
      const infos = cands.map(() => ({}));
      const found = await Promise.all(cands.map((c, i) => findPlayable(c.title, c.artist, cache0, infos[i])));
      let pick = -1, got = null, recentHit = false;
      for (let i = 0; i < cands.length; i++) {
        const g = found[i] || (i === 0 && infos[0].failed && p.enc ? p : null);   /* ncm-cli 这会儿搜不了：不冤枉这首，照宿主歌卡那个编号放，放不出来页面会跳过 */
        if (!g) continue;
        if (noRepeat && wasRecent(s0, g)) { recentHit = true; continue; }
        pick = i; got = g; break;
      }
      if (pick < 0 && recentHit) { p.drop = true; repeated.push(p.title); continue; }
      if (pick < 0) {
        cands.forEach((c, i) => { missed.push(c.title); const bb = infos[i].bad || {}; if (bb.text) why[c.title] = bb.text; });
        /* v12：不悄悄拿掉 —— 换成一行「放不了」，页面单子里留着，带去网易云 App 听的口子 */
        const b0 = infos[0].bad || {};
        const nos = { type: 'nosong', title: p.title, artist: p.artist || '', text: b0.text || '放不出来', ori: String(b0.ori || p.ori || '') };
        Object.keys(p).forEach(k => { delete p[k]; });
        Object.assign(p, nos);
        if (p.artist && !infos[0].failed) {   /* v11：这个歌手在这边能放的，下一段递给他 */
          const songsOk = await playableByArtist(p.artist, p.title);
          if (songsOk.length) alts.push({ artist: String(p.artist).split(/\s*[\/、,&，]\s*/)[0].trim(), songs: songsOk });
        }
        continue;
      }
      if (pick > 0) swapped.push({ got: got.title, skip: cands.slice(0, pick).map((c, i) => ({ title: c.title, why: found[i] ? '这几天刚放过' : ((infos[i].bad || {}).text || '放不出来') })) });
      if (found[pick]) { Object.keys(p).forEach(k => { delete p[k]; }); Object.assign(p, { type: 'song' }, found[pick]); }
      notePlayed(s0, p, key);   /* 同一段里点两遍同一首，第二遍也算撞上 */
    }
    out.parts = out.parts.filter(p => !p.drop);

    /* 记下来：本子、轨道、上回讲到哪、他最后点的歌 */
    const fresh = loadState(); const fs2 = stOf(fresh, key);
    fresh.playCache = Object.assign(fresh.playCache || {}, cache0);
    delete fresh.songCache;
    fs2.unplayable = missed;
    fs2.unplayableAlt = alts;
    fs2.unplayableWhy = why;
    fs2.repeated = repeated;
    fs2.swapped = swapped;   /* v18 */
    out.parts.filter(p => p.type === 'song').forEach(p => notePlayed(fresh, p, key));   /* v10：记进「放过的」 */
    if (out.meta.bible) { fs2.bible = out.meta.bible.slice(0, 6000); fs2.bibleAt = Date.now(); }
    if (out.meta.tracks) { fs2.tracks = out.meta.tracks.slice(0, 8); fs2.trackNo = 1; }
    if (out.meta.trackNo) fs2.trackNo = out.meta.trackNo;
    if (out.plain) fs2.tail = out.plain.slice(-400);
    const songs = out.parts.filter(p => p.type === 'song');
    if (songs.length) fs2.lastSong = songs[songs.length - 1];
    fs2.segSong = songs.length ? songs[songs.length - 1] : null;   /* v11：这一段真排进去的最后一首 */
    out.dropped = missed.concat(repeated);
    if (kind === 'open' && key === 'pillow') { fs2.order = body.order || {}; fs2.tracks = out.meta.tracks || null; fs2.trackNo = out.meta.trackNo || 1; }
    fs2.lastAt = Date.now();
    noteNight(fs2, kind, body, out);   /* SEG:RADIO v4 —— 这一段记进「今晚」，冷场半小时收 */

    /* 枕話收台那句摘要 → 他的记忆；原文不进 */
    if (out.meta.summary && key === 'pillow') {
      const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(5);
      const o = fs2.order || {};
      const content = out.meta.summary + (o.scene ? '\n（情境：' + o.scene + '；' + (o.mood || '') + '；' + (o.level || '') + '）' : '');
      const nightNow = fs2.night;   /* v16：收台了，这一晚起个标题（不挡这一段回去） */
      if (nightNow) setTimeout(() => { nightTitle(key, nightNow); }, 0);
      try { await memory().remember('枕話 · ' + day, content, '电台', 2, 'radio,枕話'); fs2.lastSummaryAt = Date.now(); delete fs2.night; }
      catch (e) { console.warn('[radio] 摘要没记进去: ' + (e && e.message)); }
      fs2.tracks = null; fs2.trackNo = null;
    }
    writeJson(STATE_FILE, fresh);

    /* 别的台说了收台：当场收，不等三十分钟（不挡这一段回去） */
    if (kind === 'bye' && key !== 'pillow') setTimeout(() => { digest(key, true).catch(() => {}); }, 0);

    await synthAll(out.parts, Object.assign({ timestamps: true }, key === 'pillow' ? { stability: PILLOW_STABILITY } : {}));   /* v14 枕話稳定度；v15 逐字时间 */
    out.parts.forEach(p => { if (p.type === 'say') p.show = p.text.replace(TAG_RE, ''); });
    archiveSeg(key, kind, body, out.parts);   /* v15：记进回放 */
    return { code: 200, obj: { ok: true, parts: out.parts, tracks: fs2.tracks || null, trackNo: fs2.trackNo || null, ncm: ncm.length ? ncm : undefined, warn: r.error || undefined, ms: Date.now() - t0 } };
  } catch (e) {
    return { code: 502, obj: { error: (e && e.message) || String(e), ms: Date.now() - t0 } };
  } finally {
    busy.delete(key);
    live.delete(key);
  }
}

/* ── SEG:RADIO v15 · 回放：每一段记一行 radio_archive/<台>.jsonl ───────────────────── */
const ARCHIVE_DIR = path.join(ROOT, 'radio_archive');
const NIGHT_GAP = 3 * 3600 * 1000;   /* 隔三小时以上算另一晚 */
const archFile = key => path.join(ARCHIVE_DIR, key + '.jsonl');
function slimPart(p) {
  const pick = ks => { const o = { type: p.type }; ks.forEach(k => { if (p[k] != null && p[k] !== '') o[k] = p[k]; }); return o; };
  if (p.type === 'say') return pick(['show', 'audio', 'align', 'pos']);
  if (p.type === 'song') return pick(['title', 'artist', 'enc', 'ori', 'cover']);
  if (p.type === 'nosong') return pick(['title', 'artist', 'text', 'ori']);
  if (p.type === 'se' || p.type === 'water') return pick(['name', 'pos']);
  if (p.type === 'gap') return pick(['ms']);
  if (p.type === 'bgm') return pick(['mood']);
  return null;
}
function archiveSeg(key, kind, body, parts) {
  try {
    const e = { t: Date.now(), kind, parts: parts.map(slimPart).filter(Boolean) };
    if (kind === 'her' || kind === 'memo' || kind === 'req') e.her = String(body.text || '').trim().slice(0, 1000);
    if (!e.parts.length && !e.her) return;
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    fs.appendFileSync(archFile(key), JSON.stringify(e) + '\n');
  } catch (err) { console.warn('[radio] 回放没记上: ' + (err && err.message)); }
}
function readArchive(key) {
  let txt = ''; try { txt = fs.readFileSync(archFile(key), 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const line of txt.split('\n')) { if (!line.trim()) continue; try { const e = JSON.parse(line); if (e && e.t) out.push(e); } catch (err) {} }
  return out.sort((a, b) => a.t - b.t);
}
function nightsOf(list) {
  const nights = [];
  for (const e of list) {
    const last = nights[nights.length - 1];
    if (!last || e.t - last.to > NIGHT_GAP) nights.push({ id: e.t, from: e.t, to: e.t, segs: [] });
    const n = nights[nights.length - 1];
    n.to = e.t; n.segs.push(e);
  }
  return nights;
}
function nightSummary(n, key) {
  const says = [], songs = [];
  let voiced = 0, total = 0, her = 0, title = '', segN = 0;
  for (const e of n.segs) {
    if (e.kind === 'title') { if (e.title) title = e.title; continue; }   /* v16：收台时起的标题 */
    segN++;
    if (e.her) her++;
    for (const p of e.parts || []) {
      if (p.type === 'say') { total++; if (p.audio) voiced++; if (says.length < 1 && p.show) says.push(p.show); }
      if (p.type === 'song' && songs.length < 6) songs.push(p.title);
    }
  }
  const o = { id: n.id, from: n.from, to: n.to, n: segN, say: total, voiced, her, songs, back: n.segs.some(e => e.bf) };
  if (title) o.title = title;
  if (key !== 'pillow' && says[0]) o.first = says[0].replace(/\s+/g, ' ').slice(0, 60);   /* 枕話不在单子上露字 */
  return o;
}
/* SEG:RADIO v19 —— 他写串场之前先查：哪几首能放、哪首这几天放过，能放的顺带几条热评 */
async function checkSongs(raw, opt) {
  const cands = String(raw || '').split(/[;；\n]/).map(x => { const f = x.split(/[|｜]/); return { title: (f[0] || '').trim().slice(0, 80), artist: (f[1] || '').trim().slice(0, 80) }; })
    .filter(c => c.title).slice(0, 5);
  const state = loadState(); const cache = state.playCache || (state.playCache = {});
  const infos = cands.map(() => ({}));
  const found = await Promise.all(cands.map((c, i) => findPlayable(c.title, c.artist, cache, infos[i])));
  const out = cands.map((c, i) => {
    const v = found[i], o = { asked: c.title + (c.artist ? '|' + c.artist : '') };
    if (v) { o.ok = true; o.title = v.title; o.artist = v.artist; o.enc = v.enc; if (wasRecent(state, v)) o.recent = true; }
    else { o.ok = false; o.why = infos[i].failed ? '这会儿网易云查不了（不一定放不了）' : ((infos[i].bad || {}).text || '放不出来'); }
    return o;
  });
  if (opt && opt.hot) {
    const want = out.filter(o => o.ok && !o.recent).slice(0, 2);
    await Promise.all(want.map(async o => { const d = await hotImpl(o.enc); o.hot = d ? pickHot(d) : null; }));
  }
  const fresh = loadState(); fresh.playCache = Object.assign(fresh.playCache || {}, cache); writeJson(STATE_FILE, fresh);
  return out;
}
function sendAlign(res, h) {
  if (!/^[0-9a-f]{40}$/.test(String(h || ''))) return send(res, 400, { error: 'h 不对' });
  let dir = ''; try { dir = tts().CACHE_DIR; } catch (e) {}
  if (!dir) return send(res, 404, { error: '没有念字模块' });
  let j = null; try { j = JSON.parse(fs.readFileSync(path.join(dir, h + '.align.json'), 'utf8')); } catch (e) {}
  if (!j) return send(res, 404, { error: '这一句没有逐字时间' });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, max-age=31536000, immutable' });
  return res.end(JSON.stringify(j));
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    /* SEG:RADIO v15 —— 字幕的逐字时间、回放 */
    if (req.method === 'GET' && p === '/api/radio/align') return sendAlign(res, u.searchParams.get('h'));
    if (req.method === 'GET' && p === '/api/radio/replay') {
      const key = u.searchParams.get('station') || '';
      if (!isStation(key)) return send(res, 400, { error: '没有这个台' });
      const nights = nightsOf(readArchive(key));
      const nid = Number(u.searchParams.get('night') || 0);
      if (nid) {
        const n = nights.find(x => x.id === nid);
        if (!n) return send(res, 404, { error: '没有这一晚' });
        return send(res, 200, { station: key, night: nightSummary(n, key), segs: n.segs });
      }
      return send(res, 200, { station: key, nights: nights.slice(-120).reverse().map(n => nightSummary(n, key)) });
    }
    if (req.method === 'GET' && p === '/api/radio/check') {   /* SEG:RADIO v19 */
      const raw = String(u.searchParams.get('songs') || '').slice(0, 600);
      if (!raw.trim()) return send(res, 400, { error: '要 songs=歌名|歌手；歌名|歌手' });
      return send(res, 200, { songs: await checkSongs(raw, { hot: u.searchParams.get('hot') !== '0' }) });
    }
    if (req.method === 'GET' && p === '/api/radio/findsong') {
      const title = String(u.searchParams.get('title') || '').slice(0, 80), artist = String(u.searchParams.get('artist') || '').slice(0, 80);
      if (!title) return send(res, 400, { error: '要歌名' });
      const state = loadState(); const cache = state.playCache || (state.playCache = {});
      const v = await findPlayable(title, artist, cache, {});
      const fresh = loadState(); fresh.playCache = Object.assign(fresh.playCache || {}, cache); writeJson(STATE_FILE, fresh);
      return v ? send(res, 200, { song: v }) : send(res, 404, { error: '这边放不了' });
    }
    if (req.method === 'GET' && p === '/api/radio/state') {
      const key = u.searchParams.get('station') || '';
      if (!isStation(key)) return send(res, 400, { error: '没有这个台' });
      const st = stOf(loadState(), key);
      const lv = live.get(key);
      return send(res, 200, { station: key, hasBible: !!st.bible, tracks: st.tracks || null, trackNo: st.trackNo || null, lastSong: st.lastSong || null, lastAt: st.lastAt || null, busy: busy.has(key),
        ncm: lv ? ncmSince(lv.from, lv.to) : [] });
    }
    if (req.method === 'GET' && p === '/api/radio/se') return send(res, 200, { have: seList() });
    const sm = req.method === 'GET' && p.match(/^\/api\/radio\/se\/([^/]+)\.mp3$/);
    if (sm) {
      let name = ''; try { name = decodeURIComponent(sm[1]); } catch (e) {}
      if (!isSe(name)) return send(res, 404, { error: '没有这个音效' });
      const file = path.join(SE_DIR, name + '.mp3');
      let st; try { st = fs.statSync(file); } catch (e) { return send(res, 404, { error: '素材库里还没有「' + name + '」' }); }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': st.size, 'Cache-Control': 'private, max-age=86400' });
      return fs.createReadStream(file).pipe(res);
    }
    if (req.method === 'GET' && p === '/api/radio/lyric') return send(res, 200, await getLyricTimed(u.searchParams.get('enc')));   /* SEG:RADIO v10 */
    if (req.method === 'GET' && p === '/api/radio/opener') {
      const key = u.searchParams.get('station') || '';
      if (!isStation(key)) return send(res, 400, { error: '没有这个台' });
      const state = loadState();
      const song = await pickOpener(key, state);
      /* v10：挑的这几秒里别的段可能写过状态 —— 重新读一遍，把搜到的、上回开场哪首、放过的并进去 */
      const fresh = loadState();
      fresh.playCache = Object.assign(fresh.playCache || {}, state.playCache || {});
      delete fresh.songCache;
      if (stOf(state, key).lastOpener) stOf(fresh, key).lastOpener = stOf(state, key).lastOpener;
      if (song) notePlayed(fresh, song, key);
      writeJson(STATE_FILE, fresh);
      if (!song) return send(res, 404, { error: '一首都没搜到' });
      return send(res, 200, { song });
    }
    if (req.method === 'POST' && p === '/api/radio/turn') {
      let body;
      try { body = await readBody(req, 20000); } catch (e) { return send(res, 400, { error: e.message }); }
      const r = await turn(body);
      return send(res, r.code, r.obj);
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: (e && e.message) || String(e) });
  }
}

startIdle();
module.exports = { handle, turn, compose, findPlayable, checkSongs, pickHot, nightTitle, cleanTitle, nightsOf, readArchive, archFile, slimPart, ARCHIVE_DIR, genSe, seList, ncmSince, digest, sweep, startIdle, forMiniMax, parseLrc, buildLyric, getLyricTimed, near, songId, whyNot, STATIONS, DEFAULT_OPENERS, SE_LIB, IDLE_MIN,
  _setSearch: f => { searchImpl = f; playMemo.clear(); artistMemo.clear(); }, _setLyric: f => { lyricImpl = f; lyricMemo.clear(); }, _setSePost: f => { sePostImpl = f; }, _setAsk: f => { askImpl = f; }, _setHot: f => { hotImpl = f; }, _resetEl: () => { elDownUntil = 0; } };
