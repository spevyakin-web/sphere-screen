// Режим чтения для купола: забирает страницу статьи по запросу, вытаскивает основной текст
// (Mozilla Readability), очищает HTML по белому списку и отдаёт JSON. Ничего не хранит,
// кроме короткого кэша Cloudflare на 15 минут.
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

const ALLOWED_ORIGINS = ['https://spevyakin-web.github.io', 'http://localhost:8766'];
const KEEP = new Set(['p', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'figure', 'figcaption', 'img', 'a', 'strong', 'b', 'em', 'i', 'pre', 'code', 'br', 'hr', 'video', 'source', 'iframe', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'sup', 'sub']);
const DROP = new Set(['script', 'style', 'noscript', 'form', 'button', 'input', 'svg', 'nav', 'aside', 'footer', 'header', 'object', 'embed']);
const VIDEO_HOSTS = /^(www\.)?(youtube\.com|youtube-nocookie\.com|player\.vimeo\.com|rutube\.ru|vk\.com|vkvideo\.ru)$/;

function cors(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin);
  return { 'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0], 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Vary': 'Origin' };
}
function json(body, status, origin, extra) {
  return new Response(JSON.stringify(body), { status, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors(origin), extra || {}) });
}
function privateHost(h) {
  return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?|\[?f[cd])/i.test(h) || h.endsWith('.local') || h.endsWith('.internal');
}
function absUrl(u, base) { try { const x = new URL(u, base); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; } }

function clean(node, base, doc) {
  for (const el of [...node.children]) {
    const tag = el.tagName.toLowerCase();
    if (DROP.has(tag)) { el.remove(); continue; }
    if (tag === 'picture') { const img = el.querySelector('img'); if (img) el.replaceWith(img); else el.remove(); if (img) clean(img.parentNode || node, base, doc); continue; }
    if (!KEEP.has(tag)) { clean(el, base, doc); el.replaceWith(...el.childNodes); continue; }
    const attrs = {};
    if (tag === 'img') {
      const src = el.getAttribute('data-src') || el.getAttribute('data-original') || el.getAttribute('data-lazy-src') || el.getAttribute('src') || '';
      const set = el.getAttribute('data-srcset') || el.getAttribute('srcset') || '';
      let best = src; if (set) { const parts = set.split(',').map(s => s.trim().split(/\s+/)); const last = parts[parts.length - 1]; if (last && last[0]) best = last[0]; }
      const u = absUrl(best, base); if (!u || u.startsWith('data:')) { el.remove(); continue; }
      attrs.src = u; attrs.alt = (el.getAttribute('alt') || '').slice(0, 300); attrs.loading = 'lazy'; attrs.referrerpolicy = 'no-referrer';
    } else if (tag === 'a') {
      const u = absUrl(el.getAttribute('href') || '', base); if (u) { attrs.href = u; attrs.target = '_blank'; attrs.rel = 'noopener noreferrer'; }
    } else if (tag === 'iframe') {
      const u = absUrl(el.getAttribute('src') || el.getAttribute('data-src') || '', base); let host = ''; try { host = new URL(u).hostname; } catch {}
      if (!u || !VIDEO_HOSTS.test(host)) { el.remove(); continue; }
      attrs.src = u; attrs.allow = 'encrypted-media; picture-in-picture; fullscreen'; attrs.allowfullscreen = ''; attrs.loading = 'lazy';
    } else if (tag === 'video') {
      const u = absUrl(el.getAttribute('src') || '', base); if (u) attrs.src = u; const p = absUrl(el.getAttribute('poster') || '', base); if (p) attrs.poster = p;
      attrs.controls = ''; attrs.playsinline = ''; attrs.preload = 'metadata';
    } else if (tag === 'source') {
      const u = absUrl(el.getAttribute('src') || '', base); if (!u) { el.remove(); continue; } attrs.src = u; const t = el.getAttribute('type'); if (t) attrs.type = t;
    } else if (tag === 'td' || tag === 'th') {
      const cs = el.getAttribute('colspan'); if (cs && /^\d+$/.test(cs)) attrs.colspan = cs;
    }
    for (const a of [...el.attributes]) el.removeAttribute(a.name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    clean(el, base, doc);
  }
}

// Чистка после Readability: меню, «хлебные крошки», блоки из ссылок, биография автора, мусор до начала текста и после конца.
const txtLen = el => (el.textContent || '').replace(/\s+/g, ' ').trim().length;
const linkLen = el => [...(el.querySelectorAll ? el.querySelectorAll('a') : [])].reduce((t, a) => t + txtLen(a), 0);
const BIO = /^[A-ZА-ЯЁ][\p{L}.' -]{2,60}\s+(is|was|—|–|-)\s+(a|an|the)?\s*[\p{L} ,-]{0,60}(writer|reporter|editor|journalist|correspondent|columnist|contributor|author)\b/iu;
function isReal(el) {
  if (el.nodeType !== 1) return false; const t = el.tagName.toLowerCase();
  if (t === 'p' || t === 'blockquote') { const n = txtLen(el); return n >= 80 && linkLen(el) / n < 0.4 && !BIO.test(el.textContent.trim()); }
  return false;
}
function tidy(root) {
  // 1. Блоки, где почти весь текст — ссылки (меню, теги, «читайте также»)
  for (const el of [...root.querySelectorAll('ul, ol, p, h2, h3, h4, table')]) {
    const n = txtLen(el); if (!n || el.querySelector('img, video, iframe')) continue;
    if (linkLen(el) / n > 0.6 && n < 600) el.remove();
  }
  // 2. Биография автора в виде абзаца
  for (const el of [...root.querySelectorAll('p')]) if (txtLen(el) < 400 && BIO.test(el.textContent.trim())) el.remove();
  // 3. Всё до первого настоящего абзаца (кроме заголовков и картинок прямо перед ним)
  const kids = [...root.childNodes]; const first = kids.findIndex(isReal);
  if (first > 0) {
    let keepFrom = first; while (keepFrom > 0) { const p = kids[keepFrom - 1]; if (p.nodeType === 1 && /^(figure|img|video|iframe)$/i.test(p.tagName) && txtLen(p) < 300) keepFrom--; else if (p.nodeType === 3 && !p.textContent.trim()) keepFrom--; else break; }
    for (const k of kids.slice(0, keepFrom)) k.remove();
  }
  // 4. Голый текст и короткие обрывки после последнего настоящего абзаца
  const k2 = [...root.childNodes]; let last = -1; k2.forEach((k, i) => { if (isReal(k) || (k.nodeType === 1 && /^(figure|ul|ol|pre|table|h2|h3)$/i.test(k.tagName) && txtLen(k) > 40)) last = i; });
  if (last >= 0) for (const k of k2.slice(last + 1)) { if (k.nodeType === 3 || (k.nodeType === 1 && !k.querySelector('img, video, iframe') && txtLen(k) < 120)) k.remove(); }
  // 5. Голые текстовые узлы прямо в корне — в абзацы
  for (const k of [...root.childNodes]) if (k.nodeType === 3) { const t = k.textContent.replace(/\s+/g, ' ').trim(); if (t.length < 80) k.remove(); }
}

async function extract(target) {
  const r = await fetch(target, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'ru,en;q=0.8' }, cf: { cacheTtl: 600, cacheEverything: true } });
  if (!r.ok) throw Object.assign(new Error('Сайт ответил ' + r.status), { status: 502 });
  const ct = r.headers.get('content-type') || ''; if (!/html/i.test(ct)) throw Object.assign(new Error('Это не страница статьи'), { status: 415 });
  const len = +(r.headers.get('content-length') || 0); if (len > 6e6) throw Object.assign(new Error('Страница слишком большая'), { status: 413 });
  const html = (await r.text()).slice(0, 6e6), base = r.url || target;
  const { document } = parseHTML(html);
  const meta = n => (document.querySelector(`meta[property="${n}"]`) || document.querySelector(`meta[name="${n}"]`))?.getAttribute('content') || '';
  const article = new Readability(document, { charThreshold: 300, keepClasses: false }).parse();
  if (!article || !article.content || (article.textContent || '').trim().length < 300) throw Object.assign(new Error('Не удалось выделить текст статьи'), { status: 422 });
  const { document: d2 } = parseHTML('<!doctype html><html><body><div id="r">' + article.content + '</div></body></html>');
  const root = d2.getElementById('r'); clean(root, base, d2);
  root.querySelectorAll('p, li, figcaption, blockquote').forEach(e => { if (!e.textContent.trim() && !e.querySelector('img, video, iframe')) e.remove(); });
  tidy(root, d2);
  const words = (article.textContent || '').trim().split(/\s+/).length;
  return {
    url: base, title: article.title || meta('og:title'), byline: article.byline || meta('author') || '', site: article.siteName || meta('og:site_name') || new URL(base).hostname.replace(/^www\./, ''),
    published: meta('article:published_time') || meta('og:published_time') || meta('date') || '', image: meta('og:image') ? absUrl(meta('og:image'), base) : '', excerpt: article.excerpt || '',
    lang: article.lang || document.documentElement.getAttribute('lang') || '', minutes: Math.max(1, Math.round(words / 180)), html: root.innerHTML
  };
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: Object.assign(cors(origin), { 'Access-Control-Max-Age': '86400' }) });
    if (request.method !== 'GET') return json({ error: 'Только GET' }, 405, origin);
    const url = new URL(request.url);
    if (url.pathname === '/' && !url.searchParams.get('url')) return json({ ok: true, service: 'kupol-reader' }, 200, origin);
    if (!ALLOWED_ORIGINS.includes(origin) && !(env && env.ALLOW_ANY_ORIGIN)) return json({ error: 'Доступ только для купола' }, 403, origin);
    let target; try { target = new URL(url.searchParams.get('url') || ''); } catch { return json({ error: 'Нужен параметр url' }, 400, origin); }
    if (!/^https?:$/.test(target.protocol) || privateHost(target.hostname)) return json({ error: 'Недопустимый адрес' }, 400, origin);
    const cache = typeof caches !== 'undefined' ? caches.default : null, key = new Request('https://kupol-reader.cache/' + encodeURIComponent(target.href) + '#' + (ALLOWED_ORIGINS.includes(origin) ? origin : ''));
    if (cache) { const hit = await cache.match(key); if (hit) return hit; }
    try {
      const data = await extract(target.href);
      const resp = json(data, 200, origin, { 'Cache-Control': 'public, max-age=900' });
      if (cache && ctx) ctx.waitUntil(cache.put(key, resp.clone()));
      return resp;
    } catch (e) { return json({ error: e.message || 'Ошибка' }, e.status || 500, origin); }
  }
};
