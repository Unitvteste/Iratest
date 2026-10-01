require('dotenv').config();

const crypto = require('crypto');
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');

const PORT = Number(process.env.PORT || 7000);
// Fallback solicitado para teste local. Remova ou substitua antes de publicar o código.
const DEFAULT_M3U_URL = 'http://cdn4k.cc/get.php?username=bzn03034he&password=q2q0e560ez&type=m3u_plus';
const M3U_URL = process.env.M3U_URL || DEFAULT_M3U_URL;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 15 * 60 * 1000);
const CATALOG_LIMIT = Number(process.env.CATALOG_LIMIT || 1000);
const MAX_M3U_ITEMS = Number(process.env.MAX_M3U_ITEMS || 20000);

if (!M3U_URL) {
  console.error('Defina M3U_URL no arquivo .env antes de iniciar o addon.');
  process.exit(1);
}

let cache = { expiresAt: 0, entries: [] };

function hash(value) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 16);
}

function cleanTitle(value = '') {
  return value
    .replace(/\bS\d{1,3}E\d{1,3}\b/gi, ' ')
    .replace(/\[[^\]]*\]|\([^)]*\)|\b(HD|FHD|UHD|4K|SD|DUB|LEG)\b/gi, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseAttributes(text) {
  const attrs = {};
  const re = /([\w-]+)="([^"]*)"/g;
  let match;
  while ((match = re.exec(text))) attrs[match[1].toLowerCase()] = match[2];
  return attrs;
}

function parseEpisode(title, attrs) {
  const source = `${title} ${attrs['tvg-name'] || ''}`;
  let match = source.match(/[Ss](\d{1,3})\s*[Ee](\d{1,3})/);
  if (match) return { season: Number(match[1]), episode: Number(match[2]) };
  match = source.match(/(?:temporada|season)\s*(\d+).*?(?:epis[oó]dio|episode|ep)\s*(\d+)/i);
  if (match) return { season: Number(match[1]), episode: Number(match[2]) };
  return null;
}

function isTvGroup(group = '') {
  return /\b(tv|live|ao vivo|canais?|channel|news|not[ií]cias?|sport|esporte|esportes|globo|band|sbt|record|espn|premiere|dazn|sportv|nba|nfl|pay-per-view|abertos?|brasileir[aã]o|jogos|a fazenda|shows?|variedades|religiosos?|m[uú]sicas?|clipes?|programas de tv|24 horas|discovery(?!\+)|cine sky)\b/i.test(group);
}

function isSeriesGroup(group = '') {
  return /\b(netflix|amazon prime|globoplay|star\+|hbo max|disney\+?|apple.?tv|crunchyroll|paramount\+?|novelas?|dorama|shorts|hentai|discovery\+|brasil paralelo)\b/i.test(group);
}

function parseStreamUrl(rawUrl) {
  const [url, optionsText] = rawUrl.split('|', 2);
  const request = {};
  for (const option of (optionsText || '').split('&')) {
    const [key, ...parts] = option.split('=');
    const value = parts.join('=').trim();
    if (!value) continue;
    const normalized = key.toLowerCase().replace(/[-_]/g, '');
    if (normalized === 'useragent') request['User-Agent'] = decodeURIComponent(value);
    if (normalized === 'httpreferrer' || normalized === 'referer') request.Referer = decodeURIComponent(value);
    if (normalized === 'origin') request.Origin = decodeURIComponent(value);
  }
  return { url: url.trim(), request };
}

function inferType(title, attrs, episode, url) {
  const group = `${attrs['group-title'] || ''} ${attrs['tvg-name'] || ''}`;
  if (isTvGroup(group)) return 'tv';
  if (episode) return 'series';
  if (/\b(filme|filmes|movie|movies|cinema)\b/i.test(group)) return 'movie';
  if (/\b(cine sky|infantis?|a[cç][aã]o|anima[cç][aã]o|animes?|com[eé]dia|document[aá]rios?|drama|faroeste|fic[cç][aã]o|fantasia|guerra|h265|lan[cç]amentos?|legendados?|marvel|dc|nacionais?|romance|suspense|terror|telecine|stand-up|u?hd|especial de natal)\b/i.test(group)) return 'movie';
  return 'unknown';
}

function parseM3U(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const entries = [];
  for (let i = 0; i < lines.length && entries.length < MAX_M3U_ITEMS; i += 1) {
    if (!lines[i].startsWith('#EXTINF')) continue;
    const url = lines[i + 1] && !lines[i + 1].startsWith('#') ? lines[i + 1] : '';
    if (!url) continue;
    const comma = lines[i].indexOf(',');
    const title = comma >= 0 ? lines[i].slice(comma + 1).trim() : 'Sem título';
    const attrs = parseAttributes(lines[i]);
    const episode = parseEpisode(title, attrs);
    const type = inferType(title, attrs, episode, url);
    const displayTitle = cleanTitle(attrs['tvg-name'] || title) || title;
    const stream = parseStreamUrl(url);
    entries.push({
      url: stream.url,
      requestHeaders: stream.request,
      title: displayTitle,
      originalTitle: title,
      logo: attrs['tvg-logo'] || undefined,
      group: attrs['group-title'] || 'Sem categoria',
      type,
      episode,
      id: `m3u-${hash(url)}`,
    });
    i += 1;
  }
  return entries;
}

async function getEntries() {
  if (cache.expiresAt > Date.now()) return cache.entries;
  const response = await fetch(M3U_URL, {
    redirect: 'follow',
    headers: { 'user-agent': 'Mozilla/5.0 (Stremio M3U Addon)' },
  });
  if (!response.ok) throw new Error(`Falha ao baixar M3U: HTTP ${response.status}`);
  const text = await response.text();
  const entries = parseM3U(text);
  cache = { entries, expiresAt: Date.now() + CACHE_TTL_MS };
  console.log(`M3U carregado: ${entries.length} itens`);
  return entries;
}

function seriesId(title) {
  return `m3u-series-${hash(cleanTitle(title).toLowerCase())}`;
}

function groupSeries(entries) {
  const map = new Map();
  for (const entry of entries.filter((item) => item.type === 'series')) {
    const id = seriesId(entry.title);
    if (!map.has(id)) map.set(id, { id, title: entry.title, logo: entry.logo, group: entry.group, episodes: [] });
    map.get(id).episodes.push(entry);
  }
  return [...map.values()];
}

function movieMeta(entry) {
  return {
    id: entry.id,
    type: 'movie',
    name: entry.title,
    poster: entry.logo,
    posterShape: 'poster',
    description: entry.group,
    genres: [entry.group],
  };
}

function seriesMeta(series) {
  return {
    id: series.id,
    type: 'series',
    name: series.title,
    poster: series.logo,
    posterShape: 'poster',
    description: series.group,
    genres: [series.group],
    videos: series.episodes
      .filter((entry) => entry.episode)
      .sort((a, b) => (a.episode.season - b.episode.season) || (a.episode.episode - b.episode.episode))
      .map((entry) => ({
        id: `${series.id}:${entry.episode.season}:${entry.episode.episode}`,
        title: entry.originalTitle,
        season: entry.episode.season,
        episode: entry.episode.episode,
        released: new Date().toISOString(),
      })),
  };
}

function tvMeta(entry) {
  return {
    id: entry.id,
    type: 'tv',
    name: entry.title,
    poster: entry.logo,
    posterShape: 'landscape',
    description: entry.group,
    genres: [entry.group],
  };
}

function streamFor(entry) {
  const request = { 'User-Agent': 'Mozilla/5.0 (Stremio M3U Addon)' , ...entry.requestHeaders };
  return {
    name: entry.type === 'tv' ? 'TV ao vivo' : 'M3U',
    title: entry.title,
    url: entry.url,
    behaviorHints: {
      notWebReady: true,
      proxyHeaders: { request },
    },
  };
}

const manifest = require('./manifest.json');

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra = {} }) => {
  try {
    const entries = await getEntries();
    const groupMatch = String(id || '').match(/^m3u-(movie|series|tv)-group-(.+)$/);
    const requestedType = groupMatch ? groupMatch[1] : id === 'm3u-movies' ? 'movie' : id === 'm3u-series' ? 'series' : id === 'm3u-tv' ? 'tv' : type;
    const requestedGroup = groupMatch ? Buffer.from(groupMatch[2], 'base64url').toString('utf8') : '';
    const genre = String(extra.genre || '').trim().toLowerCase();
    const matchesGenre = (entry) => (!genre || entry.group.toLowerCase().includes(genre)) && (!requestedGroup || entry.group === requestedGroup);
    const typedEntries = entries.filter((entry) => entry.type === requestedType && matchesGenre(entry));
    const metas = requestedType === 'movie'
      ? typedEntries.slice(0, CATALOG_LIMIT).map(movieMeta)
      : requestedType === 'tv'
        ? typedEntries.slice(0, CATALOG_LIMIT).map(tvMeta)
        : groupSeries(typedEntries).slice(0, CATALOG_LIMIT).map(seriesMeta);
    return { metas };
  } catch (error) {
    console.error(error);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
  const entries = await getEntries();
  if (type === 'movie') {
    const entry = entries.find((item) => item.id === id);
    return { meta: entry ? movieMeta(entry) : undefined };
  }
  if (type === 'tv') {
    const entry = entries.find((item) => item.id === id);
    return { meta: entry ? tvMeta(entry) : undefined };
  }
  const series = groupSeries(entries).find((item) => item.id === id);
  return { meta: series ? seriesMeta(series) : undefined };
});

builder.defineStreamHandler(async ({ type, id }) => {
  const entries = await getEntries();
  if (type === 'movie') {
    const entry = entries.find((item) => item.id === id);
    return { streams: entry ? [streamFor(entry)] : [] };
  }
  if (type === 'tv') {
    const entry = entries.find((item) => item.id === id);
    return { streams: entry ? [streamFor(entry)] : [] };
  }
  const match = id.match(/^(m3u-series-[a-f0-9]+):(\d+):(\d+)$/);
  if (!match) return { streams: [] };
  const series = groupSeries(entries).find((item) => item.id === match[1]);
  const entry = series?.episodes.find((item) => item.episode?.season === Number(match[2]) && item.episode?.episode === Number(match[3]));
  return { streams: entry ? [streamFor(entry)] : [] };
});

serveHTTP(builder.getInterface(), { port: PORT }).catch((error) => {
  console.error('Não foi possível iniciar o addon:', error);
  process.exitCode = 1;
});
