// Собирает IT-новости из RSS/Atom-лент в news.json для купола.
// Если задан ANTHROPIC_API_KEY — переводит англоязычные новости, делает короткий пересказ,
// выделяет 2–3 факта строго из текста анонса и определяет тему.
import { XMLParser } from 'fast-xml-parser';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const ROOT = new URL('../', import.meta.url);
const OUT = process.env.OUT_FILE ? process.env.OUT_FILE : new URL('news.json', ROOT);
const FEEDS = JSON.parse(await readFile(process.env.FEEDS_FILE || new URL('feeds.json', import.meta.url), 'utf8'));
const MAX_ITEMS = 220, PER_FEED = 30, MAX_AGE_DAYS = 7;
const KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const CATS = ['ИИ', 'Железо', 'Софт', 'Безопасность', 'Бизнес', 'Наука', 'Космос', 'Гаджеты', 'Игры', 'Интернет', 'Связь', 'Право'];

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', textNodeName: '#text', cdataPropName: '#cdata', removeNSPrefix: false });
const arr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
const txt = v => { if (v == null) return ''; if (typeof v === 'string' || typeof v === 'number') return String(v); if (v['#cdata'] != null) return txt(v['#cdata']); if (v['#text'] != null) return txt(v['#text']); return ''; };
const decode = s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
const strip = html => decode(String(html || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim();
const clip = (s, n) => (s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, '') + '…');
const abs = (u, base) => { try { return new URL(u, base).href; } catch { return ''; } };
const isImg = u => /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(u) || /images?|img|media|cdn|thumb/i.test(u);

function findMedia(it, html, link) {
  let img = '', video = null;
  const mc = [...arr(it['media:content']), ...arr(it['media:group']?.['media:content'])];
  for (const m of mc) {
    const u = m?.['@url'] || ''; const t = (m?.['@type'] || m?.['@medium'] || '').toLowerCase();
    if (!u) continue;
    if (!video && (t.includes('video') || /\.mp4(\?|$)/i.test(u))) video = { type: 'mp4', src: u };
    else if (!img && (t.includes('image') || isImg(u))) img = u;
  }
  const th = arr(it['media:thumbnail'])[0]?.['@url'] || arr(it['media:group']?.['media:thumbnail'])[0]?.['@url'];
  if (!img && th) img = th;
  for (const e of arr(it.enclosure)) { const u = e?.['@url'] || ''; const t = (e?.['@type'] || '').toLowerCase();
    if (!video && t.startsWith('video')) video = { type: 'mp4', src: u };
    if (!img && t.startsWith('image')) img = u; }
  if (!img) { const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html || ''); if (m) img = m[1]; }
  if (!video) { const y = /(?:youtube\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)([\w-]{11})/i.exec(html || ''); if (y) video = { type: 'youtube', id: y[1] }; }
  if (!video) { const v = /<video[^>]+src=["']([^"']+\.mp4[^"']*)["']/i.exec(html || '') || /<source[^>]+src=["']([^"']+\.mp4[^"']*)["']/i.exec(html || ''); if (v) video = { type: 'mp4', src: v[1] }; }
  img = img ? abs(decode(img), link) : '';
  if (video?.src) video.src = abs(decode(video.src), link);
  if (img && !/^https:/.test(img)) img = img.replace(/^http:/, 'https:');
  return { img: /^https:/.test(img) ? img : '', video };
}

async function getFeed(f) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(f.url, { signal: ctl.signal, headers: { 'user-agent': 'sphere-screen/1.0 (+https://spevyakin-web.github.io/sphere-screen/)', accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const x = parser.parse(await r.text());
    const rss = x.rss?.channel || x['rdf:RDF'];
    const items = rss ? arr(rss.item || x['rdf:RDF']?.item) : arr(x.feed?.entry);
    const out = [];
    for (const it of items.slice(0, PER_FEED)) {
      const title = strip(txt(it.title)); if (!title) continue;
      let link = txt(it.link); if (!link) { const ls = arr(it.link); link = (ls.find(l => (l?.['@rel'] || 'alternate') === 'alternate') || ls[0])?.['@href'] || ''; }
      link = link.trim(); if (!/^https?:/.test(link)) continue;
      const html = txt(it['content:encoded']) || txt(it.content) || txt(it.description) || txt(it.summary);
      const date = new Date(txt(it.pubDate) || txt(it['dc:date']) || txt(it.published) || txt(it.updated) || Date.now());
      if (isNaN(date) || Date.now() - date > MAX_AGE_DAYS * 864e5) continue;
      const { img, video } = findMedia(it, html, link);
      let summary = clip(strip(html).replace(/(Читать далее|Read more|Comments)\s*(→|»)?\s*$/i, ''), 1600);
      if (summary === title) summary = '';
      out.push({ id: createHash('sha1').update(link).digest('hex').slice(0, 12), src: f.name, lang: f.lang, url: link, date: date.toISOString(), title, summary, img, video });
    }
    console.log(`✓ ${f.name}: ${out.length}`); return out;
  } catch (e) { console.log(`✗ ${f.name}: ${e.message}`); return []; }
  finally { clearTimeout(tm); }
}

const embedCache = new Map();
async function canEmbed(url) {
  let host = ''; try { host = new URL(url).hostname; } catch { return false; }
  if (embedCache.has(host)) return embedCache.get(host);
  const p = (async () => {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (compatible; sphere-screen/1.0)', accept: 'text/html' } });
      try { await r.body?.cancel(); } catch {}
      if (!r.ok) return false;
      const xfo = (r.headers.get('x-frame-options') || '').toLowerCase(), csp = (r.headers.get('content-security-policy') || '').toLowerCase();
      if (xfo) return false;
      const fa = /frame-ancestors([^;]*)/.exec(csp); if (fa && !/\*|https:/.test(fa[1])) return false;
      return true;
    } catch { return false; } finally { clearTimeout(tm); }
  })();
  embedCache.set(host, p); return p;
}

async function pageText(url) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; sphere-screen/1.0)', accept: 'text/html' } });
    if (!r.ok) return '';
    let h = await r.text(); const art = /<article[\s\S]*?<\/article>/i.exec(h); if (art) h = art[0];
    const ps = [...h.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => strip(m[1])).filter(t => t.length > 60);
    return clip(ps.join('\n\n'), 6000);
  } catch { return ''; } finally { clearTimeout(tm); }
}

async function claude(batch) {
  const list = batch.map((n, k) => ({ k, lang: n.lang, title: n.title, text: clip(n.full || n.summary, 4500) }));
  const prompt = `Ты редактор русскоязычной ленты IT-новостей. Для каждой новости верни JSON-объект:
{"k": номер, "t": заголовок на русском (до 110 символов, без кликбейта), "s": подробный пересказ на русском своими словами, 6–9 предложений (120–220 слов), 2–3 абзаца через пустую строку, ТОЛЬКО по тексту ниже, без цитирования длинных фрагментов, "f": 2–3 коротких факта строго из текста ниже (числа, имена, даты), "c": тема из списка ${JSON.stringify(CATS)}}
Если новость уже на русском — заголовок не переводи, только сократи при необходимости. Ничего не добавляй от себя: если фактов в тексте нет — верни пустой массив f.
Ответь только JSON-массивом без пояснений.
Новости:
${JSON.stringify(list)}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 6000, messages: [{ role: 'user', content: prompt }] }) });
  if (!r.ok) throw new Error('Claude API ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json(); const t = j.content?.map(c => c.text || '').join('') || '[]';
  const m = t.match(/\[[\s\S]*\]/); return m ? JSON.parse(m[0]) : [];
}

const guessCat = s => { const t = s.toLowerCase();
  const R = [['ИИ', /\b(ai|ии|нейросет|llm|gpt|openai|claude|gemini|искусственн|машинн)/], ['Безопасность', /(уязвим|взлом|хакер|malware|ransom|security|breach|cve|фишинг|утечк)/], ['Железо', /(процессор|видеокарт|чип|nvidia|amd|intel|cpu|gpu|ssd|memory|памят)/],
    ['Космос', /(космос|spacex|nasa|ракет|спутник|orbit|space)/], ['Игры', /(игр|game|playstation|xbox|nintendo|steam)/], ['Гаджеты', /(смартфон|iphone|android|ноутбук|phone|laptop|watch|гаджет)/],
    ['Бизнес', /(инвест|выручк|акци|сделк|ipo|funding|raises|startup|стартап|увольн|layoff)/], ['Связь', /(5g|оператор|связ|telecom|интернет-провайдер)/], ['Право', /(суд|закон|штраф|регулятор|court|lawsuit|antitrust|fcc|ftc)/]];
  for (const [c, re] of R) if (re.test(t)) return c; return 'Софт'; };

let prev = {}; try { for (const n of JSON.parse(await readFile(OUT, 'utf8')).items || []) prev[n.id] = n; } catch {}
const raw = (await Promise.all(FEEDS.map(getFeed))).flat();
const seen = new Set(), fresh = [];
for (const n of raw.sort((a, b) => b.date.localeCompare(a.date))) { const k = n.title.toLowerCase().slice(0, 60); if (seen.has(n.id) || seen.has(k)) continue; seen.add(n.id); seen.add(k); fresh.push(n); }
const items = fresh.slice(0, MAX_ITEMS).map(n => prev[n.id] ? { ...n, ...pick(prev[n.id]) } : n);
function pick(p) { const o = {}; for (const k of ['t', 's', 'f', 'c', 'ai']) if (p[k] != null) o[k] = p[k]; return o; }

if (KEY) {
  const todo = items.filter(n => !n.ai).slice(0, 80);
  for (let i = 0; i < todo.length; i += 4) {
    const b = todo.slice(i, i + 4);
    await Promise.all(b.map(async n => { n.full = await pageText(n.url); }));
    try { const res = await claude(b); for (const r of res) { const n = b[r.k]; if (!n) continue; n.t = String(r.t || n.title).slice(0, 140); n.s = String(r.s || ''); n.f = arr(r.f).map(String).slice(0, 3); n.c = CATS.includes(r.c) ? r.c : guessCat(n.title + ' ' + n.summary); n.ai = 1; } }
    catch (e) { console.log('Claude:', e.message); break; }
  }
}
for (const n of items) { if (!n.t) n.t = n.title; if (!n.c) n.c = guessCat(n.title + ' ' + n.summary); }
await Promise.all(items.map(async n => { n.embed = await canEmbed(n.url); }));
console.log('Встраивание:', [...embedCache.keys()].length, 'доменов, разрешено у', items.filter(n => n.embed).length, 'новостей');
for (const n of items) delete n.full;
const out = { updated: new Date().toISOString(), translated: !!KEY, count: items.length, items };
await writeFile(OUT, JSON.stringify(out));
console.log(`Итого: ${items.length} новостей, перевод: ${KEY ? 'да' : 'нет (нет ANTHROPIC_API_KEY)'}`);
