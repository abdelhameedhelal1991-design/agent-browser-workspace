'use strict';

const fs = require('fs');
const path = require('path');
const BrowserUse = require('../utils/browserUse');

const DEFAULT_CDP_ENDPOINT = 'http://localhost:9222';
const CDP_PROBE_TIMEOUT = 3000;

const SITES_DIR = path.join(__dirname, 'sites');
let _siteProfilesCache = null;
let _siteControllersCache = null;

function normalizeHost(host) {
  return String(host || '').trim().toLowerCase();
}

function hostMatches(pattern, host) {
  const h = normalizeHost(host);
  const p = normalizeHost(pattern);
  if (!p || !h) return false;
  if (p === h) return true;
  if (p.startsWith('*.')) return h.endsWith(p.slice(1));
  if (p.startsWith('.')) return h.endsWith(p);
  return false;
}

function pathMatchesPrefix(pattern, pathname) {
  const p = String(pattern || '').trim();
  const pathValue = String(pathname || '').trim();
  if (!p) return false;
  return pathValue === p || pathValue.startsWith(p);
}

function loadSiteProfiles() {
  if (_siteProfilesCache) return _siteProfilesCache;

  if (!fs.existsSync(SITES_DIR)) {
    _siteProfilesCache = [];
    return _siteProfilesCache;
  }

  const entries = fs.readdirSync(SITES_DIR, { withFileTypes: true });
  const jsonFiles = entries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.json'))
    .map(e => e.name)
    .sort();

  const profiles = [];

  for (const name of jsonFiles) {
    const filePath = path.join(SITES_DIR, name);
    const raw = fs.readFileSync(filePath, 'utf-8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Invalid JSON in site profile: ${filePath}\n${err.message}`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Invalid site profile shape (expected object): ${filePath}`);
    }

    const id = parsed.id != null ? String(parsed.id) : null;
    const hosts = Array.isArray(parsed.hosts) ? parsed.hosts.map(String) : [];

    profiles.push({
      ...parsed,
      id,
      hosts,
    });
  }

  _siteProfilesCache = profiles;
  return _siteProfilesCache;
}

function loadSiteControllers() {
  if (_siteControllersCache) return _siteControllersCache;

  const controllers = new Map();
  const profiles = loadSiteProfiles();

  for (const profile of profiles) {
    if (!profile || !profile.id) continue;

    const controllerPath = path.join(SITES_DIR, `${profile.id}.js`);
    if (!fs.existsSync(controllerPath)) continue;

    // Controllers are loaded lazily from the same directory as JSON profiles.
    // This keeps selectors/config in JSON while allowing site-specific logic.
    // Each controller may export either:
    //   - a function (treated as getMarkdown)
    //   - an object { preparePage?, getMarkdown?, skipImageDownload? }
    const loaded = require(controllerPath);
    const controller = typeof loaded === 'function'
      ? { getMarkdown: loaded }
      : loaded;

    if (!controller || typeof controller !== 'object' || Array.isArray(controller)) {
      throw new Error(`Invalid site controller shape: ${controllerPath}`);
    }

    controllers.set(profile.id, controller);
  }

  _siteControllersCache = controllers;
  return _siteControllersCache;
}

function getSiteProfileById(id) {
  const wanted = String(id || '').trim();
  if (!wanted) throw new Error('Site profile id is required.');

  const profiles = loadSiteProfiles();
  const found = profiles.find(p => p.id === wanted);
  if (!found) {
    throw new Error(
      `Site profile not found: ${wanted}. `
      + `Expected a JSON file in ${SITES_DIR} with {"id":"${wanted}", ...}`,
    );
  }
  return found;
}

function getSiteProfileForHost(host) {
  const h = normalizeHost(host);
  if (!h) return null;

  const profiles = loadSiteProfiles();
  for (const profile of profiles) {
    if (!Array.isArray(profile.hosts) || profile.hosts.length === 0) continue;
    if (profile.hosts.some(p => hostMatches(p, h))) return profile;
  }
  return null;
}

function getSiteProfileForUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  const host = normalizeHost(parsed.hostname);
  const pathname = parsed.pathname || '/';

  const profiles = loadSiteProfiles();
  for (const profile of profiles) {
    if (!Array.isArray(profile.hosts) || profile.hosts.length === 0) continue;
    if (!profile.hosts.some(p => hostMatches(p, host))) continue;

    const pathPrefixes = Array.isArray(profile.pathPrefixes)
      ? profile.pathPrefixes.map(String).filter(Boolean)
      : [];

    if (pathPrefixes.length > 0 && !pathPrefixes.some(prefix => pathMatchesPrefix(prefix, pathname))) {
      continue;
    }

    return profile;
  }

  return null;
}

function getSiteControllerById(id) {
  const wanted = String(id || '').trim();
  if (!wanted) throw new Error('Site controller id is required.');
  return loadSiteControllers().get(wanted) || null;
}

function getSiteControllerForHost(host) {
  const profile = getSiteProfileForHost(host);
  if (!profile || !profile.id) return null;
  return getSiteControllerById(profile.id);
}

function getResolvedSiteInfoForUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;

  let host = '';
  try {
    host = new URL(raw).hostname || '';
  } catch {
    return null;
  }

  const profile = getSiteProfileForUrl(raw);
  if (!profile) return null;

  const selectors = (profile.scraping && typeof profile.scraping === 'object')
    ? profile.scraping.selectors
    : null;
  const selectorMap = (selectors && typeof selectors === 'object' && !Array.isArray(selectors))
    ? selectors
    : {};

  const controls = profile.controls && Array.isArray(profile.controls.items)
    ? profile.controls.items
      .filter(i => i && typeof i === 'object' && !Array.isArray(i))
      .map(i => ({
        name: i.name != null ? String(i.name) : '',
        description: i.description != null ? String(i.description) : '',
        selectorKey: i.selectorKey != null ? String(i.selectorKey) : '',
        selector: i.selectorKey && typeof selectorMap[i.selectorKey] === 'string' ? selectorMap[i.selectorKey] : '',
        actions: Array.isArray(i.actions) ? i.actions.map(String) : [],
      }))
      .filter(i => i.name)
    : [];

  return {
    id: profile.id || '',
    name: profile.name != null ? String(profile.name) : '',
    host: normalizeHost(host),
    controls,
    hasContentController: !!getSiteControllerById(profile.id),
  };
}

function getSiteContextForUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;

  let host = '';
  try {
    host = new URL(raw).hostname || '';
  } catch {
    return null;
  }

  const profile = getSiteProfileForUrl(raw);
  if (!profile) return null;

  return {
    profile,
    controller: getSiteControllerById(profile.id),
    site: getResolvedSiteInfoForUrl(raw),
  };
}

/**
 * Initialize a BrowserUse instance with auto-detection of connection mode.
 *
 * Priority:
 *   1. `options.browser` passed in — reuse it (ownsInstance = false)
 *   2. `options.launch === true` — force launch a new browser
 *   3. `options.cdp === true | string` — force CDP connection
 *   4. Auto-detect: try CDP probe, on failure — launch
 *
 * @param {object} [options]
 * @param {BrowserUse}       [options.browser]      Existing instance to reuse.
 * @param {boolean}          [options.launch]       Force launch mode.
 * @param {boolean|string}   [options.cdp]          Force CDP (true or endpoint string).
 * @param {boolean}          [options.headless]     Headless mode (default: false).
 * @param {string}           [options.endpointURL]  CDP endpoint (default: http://localhost:9222).
 * @param {number}           [options.timeout]      Navigation / connection timeout.
 * @returns {Promise<{browser: BrowserUse, ownsInstance: boolean}>}
 */
async function initBrowser(options = {}) {
  const {
    browser: existingBrowser,
    launch: forceLaunch,
    cdp: forceCdp,
    headless = false,
    endpointURL,
    timeout,
    ...launchRest
  } = options;

  if (existingBrowser) {
    return { browser: existingBrowser, ownsInstance: false };
  }

  const browser = new BrowserUse();

  if (forceLaunch) {
    const opts = { headless, ...launchRest };
    if (timeout) opts.timeout = timeout;
    await browser.launch(opts);
    return { browser, ownsInstance: true };
  }

  if (forceCdp !== undefined && forceCdp !== false) {
    const ep = typeof forceCdp === 'string' ? forceCdp : (endpointURL || DEFAULT_CDP_ENDPOINT);
    await browser.connectCDP({ endpointURL: ep, timeout: timeout || 30000 });
    return { browser, ownsInstance: true };
  }

  const ep = endpointURL || DEFAULT_CDP_ENDPOINT;
  try {
    await browser.connectCDP({ endpointURL: ep, timeout: CDP_PROBE_TIMEOUT });
    return { browser, ownsInstance: true };
  } catch {
    const freshBrowser = new BrowserUse();
    const opts = { headless, ...launchRest };
    if (timeout) opts.timeout = timeout;
    await freshBrowser.launchCDP(opts);
    return { browser: freshBrowser, ownsInstance: true };
  }
}

/**
 * Parse common CLI flags shared across all scripts.
 *
 * Recognized flags:
 *   --cdp [endpoint]   Connect via CDP
 *   --launch           Force launch new browser
 *   --headless         Headless mode
 *   --url <url>        URL to navigate to
 *   --timeout <ms>     Timeout
 *
 * @param {string[]} argv  process.argv.slice(2)
 * @returns {object}  Parsed flags object.
 */
function parseBaseFlags(argv) {
  const flags = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--cdp') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags.cdp = next; i++; }
      else flags.cdp = true;
    } else if (arg === '--launch') {
      flags.launch = true;
    } else if (arg === '--headless') {
      flags.headless = true;
    } else if (arg === '--url') {
      flags.url = argv[++i];
    } else if (arg === '--timeout') {
      flags.timeout = parseInt(argv[++i], 10) || 30000;
    } else if (arg === '--profile') {
      flags.profile = argv[++i];
    } else if (arg === '--shutdown') {
      flags.shutdown = true;
    }
  }

  return flags;
}

/**
 * Build initBrowser options from parsed CLI flags.
 * @param {object} flags  Output of parseBaseFlags.
 * @returns {object}  Options suitable for initBrowser().
 */
function flagsToBrowserOptions(flags) {
  const opts = {};
  if (flags.cdp !== undefined) opts.cdp = flags.cdp;
  if (flags.launch) opts.launch = true;
  if (flags.headless) opts.headless = true;
  if (flags.profile) opts.profile = flags.profile;
  if (flags.timeout) opts.timeout = flags.timeout;
  return opts;
}

/**
 * Safely close a browser instance only if the caller owns it.
 * @param {BrowserUse} browser
 * @param {boolean} ownsInstance
 */
async function releaseBrowser(browser, ownsInstance) {
  if (ownsInstance && browser) {
    await browser.close();
  }
}

/**
 * Shut down the background Chrome process on the CDP port.
 * @param {object} [options]
 * @param {number} [options.port]
 */
async function shutdownBrowser(options) {
  await BrowserUse.shutdown(options);
}

module.exports = {
  initBrowser,
  parseBaseFlags,
  flagsToBrowserOptions,
  releaseBrowser,
  shutdownBrowser,
  DEFAULT_CDP_ENDPOINT,
  loadSiteProfiles,
  loadSiteControllers,
  getSiteProfileById,
  getSiteProfileForHost,
  getSiteProfileForUrl,
  getSiteControllerById,
  getSiteControllerForHost,
  getResolvedSiteInfoForUrl,
  getSiteContextForUrl,
};
