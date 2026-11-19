"use strict";

const TMDB_BASE = 'https://api.themoviedb.org/3/';
const ALLOWED_PATH = /^(?:trending\/(?:all|movie|tv)\/week|discover\/tv)$/;
const ALLOWED_QUERY = new Set(['language', 'with_genres', 'with_original_language', 'sort_by', 'page']);
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 60;

function normalizeTmdbPath(value) {
  const path = String(value || '').replace(/^\/+/, '').replace(/^(?:3\/)+/, '');
  return ALLOWED_PATH.test(path) ? path : null;
}

function registerHomepageTmdbProxy(app, options = {}) {
  const getApiKey = options.getApiKey || (() => '');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const cache = new Map();
  const limits = new Map();
  app.get('/api/home/tmdb', async (req, res) => {
    const path = normalizeTmdbPath(req.query.path);
    if (!path) return res.status(400).json({ error: 'Consulta TMDB não permitida.' });
    const apiKey = String(getApiKey() || '').trim();
    if (!apiKey) return res.status(503).json({ error: 'Catálogo temporariamente indisponível.' });
    const client = String(req.ip || req.socket?.remoteAddress || 'unknown');
    const now = Date.now();
    const recent = (limits.get(client) || []).filter((stamp) => now - stamp < WINDOW_MS);
    if (recent.length >= MAX_REQUESTS_PER_WINDOW) return res.status(429).json({ error: 'Limite temporário excedido.' });
    recent.push(now);
    limits.set(client, recent);
    if (limits.size > 5000) {
      for (const [key, stamps] of limits) if (!stamps.some((stamp) => now - stamp < WINDOW_MS)) limits.delete(key);
    }
    const params = new URLSearchParams();
    for (const key of ALLOWED_QUERY) {
      const value = String(req.query[key] || '').trim();
      if (!value) continue;
      if (key === 'language' && !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(value)) continue;
      if (key === 'with_genres' && !/^\d{1,4}(?:,\d{1,4})*$/.test(value)) continue;
      if (key === 'with_original_language' && !/^[a-z]{2}$/.test(value)) continue;
      if (key === 'sort_by' && !/^(?:popularity|vote_average)\.(?:asc|desc)$/.test(value)) continue;
      if (key === 'page' && (!/^\d{1,2}$/.test(value) || Number(value) > 5)) continue;
      params.set(key, value.slice(0, 80));
    }
    const cacheKey = `${path}?${params.toString()}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now) return res.status(200).set('Cache-Control', 'public, max-age=300').type('application/json').send(cached.body);
    params.set('api_key', apiKey);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    try {
      const upstream = await fetchImpl(`${TMDB_BASE}${path}?${params.toString()}`, {
        headers: { Accept: 'application/json' }, signal: controller.signal
      });
      const body = await upstream.text();
      if (body.length > 1500000) return res.status(502).json({ error: 'Resposta TMDB inválida.' });
      if (upstream.ok) {
        cache.set(cacheKey, { body, expiresAt: now + CACHE_TTL_MS });
        while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
      }
      return res.status(upstream.status).set('Cache-Control', 'public, max-age=300').type('application/json').send(body);
    } catch {
      return res.status(502).json({ error: 'Catálogo temporariamente indisponível.' });
    } finally {
      clearTimeout(timer);
    }
  });
}

module.exports = { registerHomepageTmdbProxy, normalizeTmdbPath };
