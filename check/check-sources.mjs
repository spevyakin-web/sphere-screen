// Проверка кандидатов в RSS-источники для веток: открывается ли лента и открываются ли её статьи
// в режиме чтения (через тот же kupol-reader, что и купол). Результат: check/results.json и check/report.md.
import { XMLParser } from 'fast-xml-parser';
import { readFile, writeFile } from 'node:fs/promises';

const HERE = new URL('./', import.meta.url);
const READER = JSON.parse(await readFile(new URL('../reader.json', import.meta.url), 'utf8')).url;
const ORIGIN = 'https://spevyakin-web.github.io';
const ARTICLES = 2;

const topics = [];
for (const line of (await readFile(new URL('candidates.txt', HERE), 'utf8')).split('\n')) {
  const l = line.trim(); if (!l || (l.startsWith('#') && !l.startsWith('##'))) continue;
  if (l.startsWith('##')) { const [id, name] = l.slice(2).split('|').map(s => s.trim()); topics.push({ id, name, feeds: [] }); continue; }
  const [name, url] = l.split('|').map(s => s.trim()); topics.at(-1).feeds.push({ name, url });
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', textNodeName: '#text', cdataPropName: '#cdata', processEntities: false, htmlEntities: false });
const arr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
const txt = v => { if (v == null) return ''; if (typeof v === 'string' || typeof v === 'number') return String(v); if (v['#cdata'] != null) return txt(v['#cdata']); if (v['#text'] != null) return txt(v['#text']); return ''; };
const withTimeout = (ms) => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; };

async function getFeed(url) {
  let r = await fetch(url, { signal: withTimeout(20000), headers: { 'user-agent': 'sphere-screen/1.0 (+https://spevyakin-web.github.io/sphere-screen/)', accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' } });
  let ua = 'bot';
  if (!r.ok && [401, 403, 406, 419, 429].includes(r.status)) { r = await fetch(url, { signal: withTimeout(20000), headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', accept: '*/*', 'accept-language': 'ru,en;q=0.8' } }); ua = 'browser'; }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const body = await r.text();
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(body)) throw new Error(/<html/i.test(body) ? 'не RSS, а HTML-страница' : 'не RSS');
  const x = parser.parse(body);
  const ch = x.rss?.channel || x['rdf:RDF'];
  const items = ch ? arr(ch.item || x['rdf:RDF']?.item) : arr(x.feed?.entry);
  const out = [];
  for (const it of items) {
    let link = txt(it.link); if (!link) { const ls = arr(it.link); link = (ls.find(l => (l?.['@rel'] || 'alternate') === 'alternate') || ls[0])?.['@href'] || ''; }
    if (!link && it.guid && /^https?:/.test(txt(it.guid))) link = txt(it.guid);
    const d = new Date(txt(it.pubDate) || txt(it.published) || txt(it.updated) || txt(it['dc:date']) || 0);
    out.push({ title: txt(it.title).slice(0, 140), link: link.trim(), date: isNaN(d) ? 0 : +d });
  }
  const newest = Math.max(0, ...out.map(i => i.date));
  return { ua, count: out.length, newest, items: out.filter(i => /^https?:/.test(i.link)) };
}

async function read(link) {
  try {
    const r = await fetch(READER + '/?url=' + encodeURIComponent(link), { signal: withTimeout(30000), headers: { Origin: ORIGIN } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: j.error || 'HTTP ' + r.status };
    const text = (j.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const words = text ? text.split(' ').length : 0;
    return { ok: words >= 120, words, error: words >= 120 ? '' : 'мало текста (' + words + ' слов)' };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

async function check(f) {
  const res = { ...f, feed: false, count: 0, ageH: null, read: 0, tried: 0, words: [], errors: [] };
  try {
    const fd = await getFeed(f.url);
    res.feed = fd.count > 0; res.count = fd.count; res.ua = fd.ua;
    res.ageH = fd.newest ? Math.round((Date.now() - fd.newest) / 36e5) : null;
    for (const it of fd.items.slice(0, ARTICLES + 1)) {
      if (res.tried >= ARTICLES) break;
      res.tried++; const r = await read(it.link);
      if (r.ok) { res.read++; res.words.push(r.words); } else res.errors.push(r.error);
    }
  } catch (e) { res.errors.push('лента: ' + (e.name === 'AbortError' ? 'таймаут' : e.message || e)); }
  res.status = !res.feed ? 'feed-fail' : res.read === res.tried && res.read > 0 ? 'ok' : res.read > 0 ? 'partial' : 'reader-fail';
  return res;
}

const all = topics.flatMap(t => t.feeds.map(f => ({ t, f })));
const cache = new Map(); let i = 0;
if (process.env.RECHECK) { try { const prev = JSON.parse(await readFile(new URL('results.json', HERE), 'utf8')); for (const t of prev.topics) for (const f of t.feeds) if (f.status === 'ok') cache.set(f.url, f); } catch {} }
await Promise.all(Array.from({ length: +(process.env.CONC || 8) }, async () => {
  while (i < all.length) { const { f } = all[i++]; if (!cache.has(f.url)) { cache.set(f.url, null); cache.set(f.url, await check(f)); console.log(cache.get(f.url).status.padEnd(12), f.name); } }
}));
while ([...cache.values()].some(v => v === null)) await new Promise(r => setTimeout(r, 500));

const results = topics.map(t => ({ id: t.id, name: t.name, feeds: t.feeds.map(f => ({ ...cache.get(f.url), name: f.name })) }));
await writeFile(new URL('results.json', HERE), JSON.stringify({ checked: new Date().toISOString(), reader: READER, topics: results }, null, 1));

const icon = { ok: '✅', partial: '🟡', 'reader-fail': '📰', 'feed-fail': '❌' };
let md = `# Проверка источников — ${new Date().toISOString().slice(0, 16)} UTC\n\n✅ лента и режим чтения работают · 🟡 режим чтения открыл не все статьи · 📰 лента есть, режим чтения не открывает · ❌ лента не открылась\n`;
for (const t of results) {
  md += `\n## ${t.name}\n\n| | Источник | Новостей | Свежесть, ч | Чтение | Слов | Ошибка |\n|---|---|---|---|---|---|---|\n`;
  for (const f of t.feeds) md += `| ${icon[f.status]} | [${f.name}](${f.url}) | ${f.count} | ${f.ageH ?? '—'} | ${f.read}/${f.tried} | ${f.words.join(', ')} | ${[...new Set(f.errors)].join('; ').replace(/\|/g, '/')} |\n`;
}
await writeFile(new URL('report.md', HERE), md);
const n = s => [...cache.values()].filter(v => v.status === s).length;
console.log(`ok ${n('ok')}, partial ${n('partial')}, reader-fail ${n('reader-fail')}, feed-fail ${n('feed-fail')}`);
