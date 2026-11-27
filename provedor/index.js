const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const appDefaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'app-config.json'), 'utf8'));

function readPrivateConfig() {
  const raw = process.env.ADDON_PRIVATE_CONFIG_JSON;
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
    return value;
  } catch {
    throw new Error('ADDON_PRIVATE_CONFIG_JSON inválido; confira a estrutura JSON.');
  }
}

const privateConfig = readPrivateConfig();
const privateApp = privateConfig.app && typeof privateConfig.app === 'object' && !Array.isArray(privateConfig.app)
  ? privateConfig.app
  : {};
const app = { ...appDefaults, ...privateApp };

function readLocalXtreamSources() {
  const xtreamDir = path.join(ROOT, 'xtream');
  return (fs.existsSync(xtreamDir) ? fs.readdirSync(xtreamDir) : [])
    .filter((name) => name.endsWith('.json'))
    .sort()
    .flatMap((name) => {
      try {
        const source = JSON.parse(fs.readFileSync(path.join(xtreamDir, name), 'utf8'));
        return source.id && source.base && source.username && source.password ? [source] : [];
      } catch {
        return [];
      }
    });
}

function normalizeXtreamSources(sources) {
  if (!Array.isArray(sources)) return [];
  return sources.flatMap((source) => {
    if (!source || typeof source !== 'object' ||
        !source.id || !source.base || !source.username || !source.password) return [];
    return [{ ...source, base: String(source.base).replace(/\/$/, '') }];
  });
}

const XTREAM_SOURCES = Array.isArray(privateConfig.xtream)
  ? normalizeXtreamSources(privateConfig.xtream)
  : normalizeXtreamSources(readLocalXtreamSources());

const localEpgPath = path.join(ROOT, 'epg.json');
const localEpgSources = fs.existsSync(localEpgPath)
  ? JSON.parse(fs.readFileSync(localEpgPath, 'utf8'))
  : [];
const EPG_SOURCES = Array.isArray(privateConfig.epg) ? privateConfig.epg : localEpgSources;

module.exports = Object.freeze({ app, XTREAM_SOURCES, EPG_SOURCES });
