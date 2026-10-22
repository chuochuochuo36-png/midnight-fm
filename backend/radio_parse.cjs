'use strict';
/* SEG:RADIO v1 · 把他这一段话拆开 (2026-10-17)

   他回的是一整段要念的话，里面夹着几样不念的东西：
     <本子>…</本子>   故事台的计划，存下来，下次开播带给他
     <轨道>…</轨道>   枕話今晚的轨道表，一行一轨
     <第N轨>          枕話进到第几轨
     <摘要>…</摘要>   枕話收台时那一句，进他的记忆
     [song:歌名|歌手] 放一首歌（也认聊天里歌卡的 [歌] 标题|歌手|enc|ori|封面）
     [song:歌名|歌手；歌名|歌手；…] SEG:RADIO v18：一次几首候选（最多五首），电台挨个看能不能放，放第一首能放的
     [左耳] [右耳] [正前方] [贴近] [远一点] [身后]   声音从哪来，管到下一个位置
     [耳语] [叹气] [轻笑] [喘] [停顿]                 语气，只管紧跟着的那句
     [se:雨] …                                         音效，只认 SE 那张表
     [bgm:安静] …                                      底下那层配乐换个样子（安静 / 温柔 / 暧昧 / 悬疑 / 恐怖 / 关）
   拆出来是一串 parts，按顺序播：say（念）/ se（音效）/ song（歌）。

   ★ 纯函数，不碰盘、不碰网，方便单测（radio_parse.test.cjs）。
   ★ 认不出的方括号小标记（表情、[[face:]]、[[tts:]] 这些聊天里的）一律剥掉，宁可少念一个字，不能把「方括号 face 冒号」念出来。
   ★ SEG:RADIO v2 · 枕話（parse(raw, { pillow: true })）—— 她 10-17：「nsfw 的节奏要慢一点 停顿拉长」「应该是没有动作」：
     [停顿] 变成真的空白（gap 1600ms）；一行一句分开念，句和句之间留 600ms；括号 / 星号里的动作剥掉不念；
     左耳、右耳、贴近说的话，他没标语气就默认耳语。
   ★ SEG:RADIO v3 —— 她 10-17 拿来一份「让小机学会亲亲」（ElevenLabs 音效生成 + 方括号标签的笔记）：
     音效表多了 轻吻 / 亲吻 / 拍墙 / 拍打 / 脚步（音效是 ElevenLabs 事先生成好存成素材的，不是现场合成）；
     语气多了 低声 / 压着声音 / 气息发抖（v3 模型认 [low voice] [under breath] [shaky breath]）。
   ★ SEG:RADIO v4 —— 群里推的那篇（ai-voice-breath-kiss-water）：「主要是插进水声，11labs 的水声很假」。
     · 水声不再是放完才说话的一个音效，改成垫在他说话底下的一层真录音：[湿] [黏] [水声] 开，[干] 关；
       这一段念完还开着的，段尾自动关（页面会留一秒尾巴再淡出）。老写法 [se:水声] 在枕話里也当 [水声]。
     · 枕話不再一行一句分开念（那篇：切成一句一句念，喘全断了，每块开头都像重新开机）。
       现在只在 位置 / 停顿 / 音效 / 配乐 / 水声 换的地方断开，中间的几句一口气念；靠耳朵说、他没标语气的，块头补一个轻的
       [low and close to her ear, unhurried]（那篇：往轻里写，猛的词一用嗓子就开始演）。 */

const POS = ['左耳', '右耳', '正前方', '贴近', '远一点', '身后'];
const TONE = { '耳语': 'whispers', '叹气': 'sighs', '轻笑': 'chuckles', '喘': 'breathing heavily', '停顿': 'pause',
  '低声': 'low voice', '压着声音': 'under breath', '气息发抖': 'shaky breath' };
const SE = ['雨', '心跳', '关门', '衣料', '床单', '水声', '风', '轻吻', '亲吻', '拍墙', '拍打', '脚步'];
const BGM = ['安静', '温柔', '暧昧', '悬疑', '恐怖', '关'];
const MAX_SAY = 700;   /* 一块念的字太长就从句号处切开，第一块能早点念出来 */
const GAP_PAUSE = 1600;
const WHISPER_POS = ['左耳', '右耳', '贴近'];
const EAR_TAG = '[low and close to her ear, unhurried] ';
const WATER = { '湿': '湿', '黏': '黏', '水声': '水声' };   /* 枕話里垫在说话底下的那层：[湿] [黏] [水声]，[干] 关 */
const TAG_RE = /\[[a-z][a-z ,']*\]\s*/g;   /* 念给 ElevenLabs 的英文方括号（剥掉就是给她看的字） */

function takeBlocks(text, tag) {
  const out = [];
  const re = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'g');
  text = text.replace(re, (_, body) => { out.push(body.trim()); return '\n'; });
  return { text, last: out.length ? out[out.length - 1] : null };
}

function splitLong(s) {
  if (s.length <= MAX_SAY) return [s];
  const out = [];
  let rest = s;
  while (rest.length > MAX_SAY) {
    const win = rest.slice(0, MAX_SAY);
    let cut = Math.max(win.lastIndexOf('。'), win.lastIndexOf('！'), win.lastIndexOf('？'), win.lastIndexOf('…'), win.lastIndexOf('\n'));
    if (cut < MAX_SAY * 0.4) cut = MAX_SAY - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) out.push(rest.trim());
  return out.filter(Boolean);
}

function parse(raw, opts) {
  const pillow = !!(opts && opts.pillow);
  let text = String(raw || '').replace(/\r/g, '');
  const meta = { bible: null, tracks: null, trackNo: null, summary: null };

  let b = takeBlocks(text, '本子'); text = b.text; meta.bible = b.last;
  b = takeBlocks(text, '轨道'); text = b.text;
  if (b.last) meta.tracks = b.last.split('\n').map(l => l.replace(/^\s*(?:\d+[.、:：)]\s*|[-*·]\s*)/, '').trim()).filter(Boolean);
  b = takeBlocks(text, '摘要'); text = b.text; meta.summary = b.last;
  text = text.replace(/<第\s*(\d+)\s*轨>/g, (_, n) => { meta.trackNo = Number(n); return '\n'; });

  /* 聊天里的杂物：[[face:x]] [[tts:ja]] [sticker:x] [表情:x] [image:x] [page:x] —— 剥掉 */
  text = text.replace(/\[\[[^\]]*\]\]/g, '')
    .replace(/\[(?:sticker|表情|image|图|page)[:：][^\]]*\]/gi, '');
  /* 服务器在回复里塞的东西：歌没搜到时那句（系统：……），图、页面、视频、各种函和卡片的整行 —— 都不是要念的 */
  text = text.replace(/（系统[:：][^）]*）/g, '')
    .replace(/^[ \t]*\[(?:image|page|video|file|邀请函|和好函|箋|狀|片|郵|卡|票|约定|表情)\][^\n]*$/gm, '');

  /* 枕話：括号、星号里的动作不念（「（靠近）」「*把灯关了*」这种） */
  if (pillow) text = text.replace(/（[^（）\n]{1,80}）|\([^()\n]{1,80}\)|\*[^*\n]{1,80}\*/g, '');

  const parts = [];
  let pos = null;
  let buf = '';
  const flush = () => {
    const t = buf.replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim();
    buf = '';
    if (!t) return;
    for (const piece of splitLong(t)) parts.push({ type: 'say', text: piece, pos: pos });
  };

  const TOKEN = /\[song[:：]([^\]|｜]+)[|｜]?([^\]]*)\]|\[歌\]\s*([^\n]+)|\[se[:：]([^\]]+)\]|\[bgm[:：]([^\]]+)\]|\[([^\[\]\n]{1,6})\]/g;
  let last = 0, m;
  while ((m = TOKEN.exec(text))) {
    buf += text.slice(last, m.index);
    last = TOKEN.lastIndex;
    if (m[1] !== undefined) {                       /* [song:歌名|歌手]；v18 起可以一次写几首候选：[song:歌名|歌手；歌名|歌手；…] */
      flush();
      const inner = m[0].slice(m[0].search(/[:：]/) + 1, -1);
      const cands = inner.split(/[;；]/).map(x => { const f = x.split(/[|｜]/); return { title: (f[0] || '').trim(), artist: (f[1] || '').trim() }; }).filter(c => c.title).slice(0, 5);
      const song = { type: 'song', title: cands.length ? cands[0].title : m[1].trim(), artist: cands.length ? cands[0].artist : (m[2] || '').trim() };
      if (cands.length > 1) song.alts = cands.slice(1);   /* 电台挨个看能不能放，放第一首能放的 */
      parts.push(song);
    } else if (m[3] !== undefined) {                /* [歌] 标题|歌手|enc|ori|封面 */
      flush();
      const f = m[3].split('|').map(x => x.trim());
      parts.push({ type: 'song', title: f[0] || '', artist: f[1] || '', enc: f[2] || '', ori: f[3] || '', cover: f[4] || '' });
    } else if (m[4] !== undefined) {                /* [se:雨] */
      const name = m[4].trim();
      if (pillow && name === '水声') { flush(); parts.push({ type: 'water', name: '水声' }); }   /* 枕話里水声改成垫底那层 */
      else if (SE.indexOf(name) >= 0) { flush(); parts.push({ type: 'se', name: name, pos: pos }); }
    } else if (m[5] !== undefined) {                /* [bgm:悬疑] */
      const mood = m[5].trim();
      if (BGM.indexOf(mood) >= 0) { flush(); parts.push({ type: 'bgm', mood: mood }); }
    } else {
      const w = m[6].trim();
      if (POS.indexOf(w) >= 0) { flush(); pos = w; }
      else if (pillow && Object.prototype.hasOwnProperty.call(WATER, w)) { flush(); parts.push({ type: 'water', name: WATER[w] }); }
      else if (pillow && w === '干') { flush(); parts.push({ type: 'water', name: null }); }
      else if (w === '停顿' && pillow) { flush(); parts.push({ type: 'gap', ms: GAP_PAUSE }); }
      else if (Object.prototype.hasOwnProperty.call(TONE, w)) {
        /* 语气标记原样留在念的字里，换成 ElevenLabs 认的英文方括号；停顿就换成省略号 */
        buf += w === '停顿' ? '……' : '[' + TONE[w] + '] ';
      }
      /* 别的短方括号（比如他顺手写的 [笑]）直接丢掉 */
    }
  }
  buf += text.slice(last);
  flush();

  /* 枕話：一块一口气念（v4 起不再一行一句）；单独一行的语气标签贴到下一句头上；靠耳朵说、没标语气的，块头补一个轻的 */
  if (pillow) {
    const out = [];
    for (const p of parts) {
      if (p.type !== 'say') { out.push(p); continue; }
      const t = p.text.replace(/(\[[a-z][a-z ,']*\])[ \t]*\n\s*/g, '$1 ').replace(/\s*\[[a-z][a-z ,']*\]\s*$/, '').trim();
      if (!t || !t.replace(TAG_RE, '').trim()) continue;
      out.push({ type: 'say', text: (WHISPER_POS.indexOf(p.pos) >= 0 && !/^\[[a-z]/.test(t)) ? EAR_TAG + t : t, pos: p.pos });
    }
    /* 头上、连着的空白合成一个，尾巴上的空白去掉；连着的水声开关只留最后一个；段尾水声还开着就关掉 */
    parts.length = 0;
    for (const p of out) {
      const prev = parts[parts.length - 1];
      if (p.type === 'gap' && (!prev || prev.type === 'gap')) { if (prev) prev.ms = Math.max(prev.ms, p.ms); continue; }
      if (p.type === 'water' && prev && prev.type === 'water') { parts[parts.length - 1] = p; continue; }
      parts.push(p);
    }
    while (parts.length && parts[parts.length - 1].type === 'gap') parts.pop();
    let wet = null;
    for (const p of parts) if (p.type === 'water') wet = p.name;
    if (wet) parts.push({ type: 'water', name: null });
    while (parts.length && parts[0].type === 'water' && !parts[0].name) parts.shift();
  }

  /* 一首歌也没有、一句话也没有：他这一轮可能只写了本子。原样告诉调用方，不硬凑 */
  const plain = parts.filter(p => p.type === 'say').map(p => p.text.replace(TAG_RE, '')).join('\n');
  return { parts, plain, meta };
}

module.exports = { parse, POS, TONE, SE, BGM, WATER, TAG_RE };
