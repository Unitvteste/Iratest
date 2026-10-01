require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { Readable } = require('stream');
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');

const PORT = Number(process.env.PORT || 7000);
const M3U_URL = process.env.M3U_URL;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 15 * 60 * 1000);
const M3U_TIMEOUT_MS = Number(process.env.M3U_TIMEOUT_MS || 120 * 1000);
const CATALOG_LIMIT = Number(process.env.CATALOG_LIMIT || 1000);
const SAFE_MODE = process.env.CONTENT_PROFILE !== 'full';

if (!M3U_URL) {
  console.error('Defina M3U_URL no arquivo .env antes de iniciar o addon.');
  process.exit(1);
}

const CACHE_FILE = path.join(os.tmpdir(), `iracemaflix-m3u-v5-${SAFE_MODE ? 'clean' : 'full'}.jsonl`);
let cache = { expiresAt: 0, count: 0, loading: null };

function hash(value) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 16);
}

function cleanTitle(value = '') {
  return value
    .replace(/\bS\d{1,3}\s*E\d{1,3}\b/gi, ' ')
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
  return /\b(tv|live|ao vivo|canais?|channel|news|not[ií]cias?|sport|sports|esporte|esportes|sports world|globo|band|sbt|record|espn|premiere|dazn|sportv|nba|nfl|pay-per-view|abertos?|brasileir[aã]o|jogos|a fazenda|shows?|variedades|religiosos?|m[uú]sicas?|clipes?|programas de tv|24 horas|discovery(?!\+)|cine sky|eleven sports)\b/i.test(group);
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
  const group = attrs['group-title'] || '';
  const name = attrs['tvg-name'] || title;
  if (isSeriesGroup(group)) return 'series';
  if (/^(telecine|hbo|max|documentarios|filmes e series|legendados|uhd 4k|h265\/hevc|infantis)$/i.test(group.trim())) return 'tv';
  if (isTvGroup(group)) return 'tv';
  if (episode) return 'series';
  if (/\b(filme|filmes|movie|movies|cinema)\b/i.test(group)) return 'movie';
  if (/\b(cine sky|infantis?|a[cç][aã]o|anima[cç][aã]o|animes?|com[eé]dia|document[aá]rios?|drama|faroeste|fic[cç][aã]o|fantasia|guerra|h265|lan[cç]amentos?|legendados?|marvel|dc|nacionais?|romance|suspense|terror|telecine|stand-up|u?hd|especial de natal)\b/i.test(group)) return 'movie';
  if (!group && isTvGroup(name)) return 'tv';
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

function entryFromLines(extinf, rawUrl) {
  const comma = extinf.indexOf(',');
  const title = comma >= 0 ? extinf.slice(comma + 1).trim() : 'Sem título';
  const attrs = parseAttributes(extinf);
  const episode = parseEpisode(title, attrs);
  const stream = parseStreamUrl(rawUrl);
  return {
    url: stream.url,
    requestHeaders: stream.request,
    title: cleanTitle(attrs['tvg-name'] || title) || title,
    originalTitle: title,
    logo: attrs['tvg-logo'] || undefined,
    group: attrs['group-title'] || 'Sem categoria',
    type: inferType(title, attrs, episode, rawUrl),
    episode,
    id: `m3u-${hash(rawUrl)}`,
  };
}

function isAdultEntry(entry) {
  const text = `${entry.group} ${entry.title} ${entry.originalTitle}`;
  return /(?:\+18|18\+|adultos?|porn(?:o|ô)?|hentai|xxx|er[oó]tico|sexo|onlyfans|playboy|novinhas?)/i.test(text);
}

async function loadPlaylistToDisk() {
  const urls = M3U_URL.startsWith('http://')
    ? [M3U_URL.replace(/^http:\/\//i, 'https://'), M3U_URL]
    : [M3U_URL];
  let response;
  let lastError;
  for (const url of urls) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), M3U_TIMEOUT_MS);
    try {
      response = await fetch(url, {
        redirect: 'follow', signal: controller.signal,
        headers: { 'user-agent': 'Mozilla/5.0 (Stremio M3U Addon)' },
      });
      if (response.ok) break;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error.name === 'AbortError'
        ? new Error(`tempo esgotado após ${M3U_TIMEOUT_MS} ms`)
        : error;
    } finally {
      clearTimeout(timeout);
    }
    response = null;
  }
  if (!response) throw new Error(`Falha ao baixar M3U: ${lastError?.message || 'erro de conexão'}`);
  if (!response.ok) throw new Error(`Falha ao baixar M3U: HTTP ${response.status}`);
  if (!response.body) throw new Error('A resposta M3U não possui corpo');
  const tempFile = `${CACHE_FILE}.${process.pid}.tmp`;
  const output = fs.createWriteStream(tempFile, { encoding: 'utf8' });
  const input = readline.createInterface({ input: Readable.fromWeb(response.body), crlfDelay: Infinity });
  let extinf = null;
  let count = 0;
  let skippedAdult = 0;
  for await (const rawLine of input) {
    const line = rawLine.trim();
    if (line.startsWith('#EXTINF')) {
      extinf = line;
    } else if (extinf && line && !line.startsWith('#')) {
      const entry = entryFromLines(extinf, line);
      if (SAFE_MODE && isAdultEntry(entry)) {
        skippedAdult += 1;
        extinf = null;
        continue;
      }
      if (!output.write(`${JSON.stringify(entry)}\n`)) await new Promise((resolve) => output.once('drain', resolve));
      count += 1;
      extinf = null;
    }
  }
  await new Promise((resolve, reject) => { output.end((error) => error ? reject(error) : resolve()); });
  if (!count) { fs.rmSync(tempFile, { force: true }); throw new Error('A URL respondeu, mas nenhum item M3U válido foi encontrado'); }
  fs.renameSync(tempFile, CACHE_FILE);
  console.log(`M3U carregado integralmente: ${count} itens (cache em disco${SAFE_MODE ? `, ${skippedAdult} adultos removidos` : ''})`);
  return count;
}

async function ensurePlaylist() {
  if (cache.expiresAt > Date.now() && fs.existsSync(CACHE_FILE)) return cache;
  if (!cache.loading) {
    cache.loading = loadPlaylistToDisk()
      .then((count) => { cache = { count, expiresAt: Date.now() + CACHE_TTL_MS, loading: null }; return cache; })
      .catch((error) => { cache.loading = null; throw error; });
  }
  return cache.loading;
}

async function* entriesFromDisk() {
  const input = readline.createInterface({ input: fs.createReadStream(CACHE_FILE), crlfDelay: Infinity });
  for await (const line of input) if (line) yield JSON.parse(line);
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

function seriesCatalogMeta(series) {
  return {
    id: series.id,
    type: 'series',
    name: series.title,
    poster: series.logo,
    posterShape: 'poster',
    description: series.group,
    genres: [series.group],
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

const baseManifest = require('./manifest.json');
const manifest = SAFE_MODE
  ? { ...baseManifest, id: 'community.m3u.catalog', name: 'Iracemaflix', description: 'Filmes, séries e TV sem categorias ou conteúdo adulto.' }
  : { ...baseManifest, id: 'community.m3u.catalog.full', name: 'Iracemaflix • Completo', description: 'Playlist completa com filmes, séries e TV.' };

const builder = new addonBuilder(manifest);

async function findEntry(id) {
  for await (const entry of entriesFromDisk()) if (entry.id === id) return entry;
  return undefined;
}

async function collectEntries(type, group, genre) {
  const result = [];
  for await (const entry of entriesFromDisk()) {
    if (entry.type !== type) continue;
    if (group && entry.group !== group) continue;
    if (genre && !entry.group.toLowerCase().includes(genre)) continue;
    result.push(entry);
    if (type !== 'series' && result.length >= CATALOG_LIMIT) break;
  }
  return result;
}

async function collectSeriesCatalog(group, genre) {
  const series = new Map();
  for await (const entry of entriesFromDisk()) {
    if (entry.type !== 'series') continue;
    if (group && entry.group !== group) continue;
    if (genre && !entry.group.toLowerCase().includes(genre)) continue;
    const id = seriesId(entry.title);
    if (!series.has(id)) series.set(id, { id, title: cleanTitle(entry.title), logo: entry.logo, group: entry.group, episodes: [] });
    if (series.size >= CATALOG_LIMIT) break;
  }
  return [...series.values()];
}

async function loadSeries(id) {
  const episodes = [];
  let series;
  for await (const entry of entriesFromDisk()) {
    if (entry.type !== 'series' || seriesId(entry.title) !== id) continue;
    if (!series) series = { id, title: cleanTitle(entry.title), logo: entry.logo, group: entry.group, episodes };
    episodes.push(entry);
  }
  return series;
}

builder.defineCatalogHandler(async ({ type, id, extra = {} }) => {
  try {
    await ensurePlaylist();
    const groupMatch = String(id || '').match(/^m3u-(movie|series|tv)-group-(.+)$/);
    const requestedType = groupMatch ? groupMatch[1] : id === 'm3u-movies' ? 'movie' : id === 'm3u-series' ? 'series' : id === 'm3u-tv' ? 'tv' : type;
    const requestedGroup = groupMatch ? Buffer.from(groupMatch[2], 'base64url').toString('utf8') : '';
    const rawGenre = String(extra.genre || '').trim().toLowerCase();
    const genre = ['all', 'todos', 'todos os gêneros', 'todos os generos', 'all genres'].includes(rawGenre) ? '' : rawGenre;
    const typedEntries = requestedType === 'series'
      ? await collectSeriesCatalog(requestedGroup, genre)
      : await collectEntries(requestedType, requestedGroup, genre);
    const metas = requestedType === 'movie'
      ? typedEntries.map(movieMeta)
      : requestedType === 'tv'
        ? typedEntries.map(tvMeta)
        : typedEntries.map(seriesCatalogMeta);
    return { metas };
  } catch (error) {
    console.error(error);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
  await ensurePlaylist();
  if (type === 'movie') {
    const entry = await findEntry(id);
    return { meta: entry ? movieMeta(entry) : undefined };
  }
  if (type === 'tv') {
    const entry = await findEntry(id);
    return { meta: entry ? tvMeta(entry) : undefined };
  }
  const series = await loadSeries(id);
  return { meta: series ? seriesMeta(series) : undefined };
});

builder.defineStreamHandler(async ({ type, id }) => {
  await ensurePlaylist();
  if (type === 'movie') {
    const entry = await findEntry(id);
    return { streams: entry ? [streamFor(entry)] : [] };
  }
  if (type === 'tv') {
    const entry = await findEntry(id);
    return { streams: entry ? [streamFor(entry)] : [] };
  }
  const match = id.match(/^(m3u-series-[a-f0-9]+):(\d+):(\d+)$/);
  if (!match) return { streams: [] };
  const series = await loadSeries(match[1]);
  const entry = series?.episodes.find((item) => item.episode?.season === Number(match[2]) && item.episode?.episode === Number(match[3]));
  return { streams: entry ? [streamFor(entry)] : [] };
});

serveHTTP(builder.getInterface(), { port: PORT }).catch((error) => {
  console.error('Não foi possível iniciar o addon:', error);
  process.exitCode = 1;
});
