'use strict';

const fs = require('fs');
const path = require('path');
const getContent = require('./getContent');
const getForms = require('./getForms');
const { isPdfUrl } = require('../utils/browserUse');
const {
  initBrowser,
  parseBaseFlags,
  flagsToBrowserOptions,
  releaseBrowser,
  getSiteProfileById,
} = require('./_shared');

// ============================================================
//  GOOGLE-SPECIFIC SELECTORS
//  Centralised for easy maintenance when Google changes markup.
// ============================================================

const GOOGLE_PROFILE_ID = 'google-search';

function getGoogleSelectors() {
  const profile = getSiteProfileById(GOOGLE_PROFILE_ID);
  const selectors = profile?.scraping?.selectors;

  if (!selectors || typeof selectors !== 'object' || Array.isArray(selectors)) {
    throw new Error(`Invalid site profile "${GOOGLE_PROFILE_ID}": missing scraping.selectors object`);
  }

  const requiredKeys = [
    'searchInput',
    'resultAnchor',
    'resultTitle',
    'resultBlock',
    'resultSnippet',
    'adContainers',
    'nextPage',
    'paginationLink',
  ];

  for (const key of requiredKeys) {
    if (typeof selectors[key] !== 'string' || selectors[key].trim().length === 0) {
      throw new Error(`Invalid site profile "${GOOGLE_PROFILE_ID}": scraping.selectors.${key} must be a non-empty string`);
    }
  }

  const baseUrl = typeof profile.baseUrl === 'string' && profile.baseUrl.trim()
    ? profile.baseUrl.trim()
    : 'https://www.google.com';

  return { url: baseUrl, ...selectors };
}

const GOOGLE = getGoogleSelectors();

const LINKS_FILENAME = 'links.json';

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function inferLinkType(url) {
  if (isPdfUrl(url)) return 'pdf';

  let pathname = '';
  try {
    pathname = new URL(url).pathname || '';
  } catch {
    pathname = url;
  }

  const ext = path.extname(pathname).toLowerCase();
  if (!ext) return 'html';

  // Treat common web endpoints as html documents
  if (['.html', '.htm', '.php', '.asp', '.aspx', '.jsp'].includes(ext)) return 'html';

  return ext.slice(1);
}

function readLinksFile(filePath) {
  if (!fs.existsSync(filePath)) return [];

  const raw = fs.readFileSync(filePath, 'utf-8').trim();
  if (!raw) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${filePath}\n${err.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid links file shape in ${filePath}: expected a JSON array`);
  }

  for (const [i, item] of parsed.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Invalid links file item at index ${i} in ${filePath}: expected an object`);
    }
    if (typeof item.url !== 'string' || item.url.trim().length === 0) {
      throw new Error(`Invalid links file item at index ${i} in ${filePath}: "url" must be a non-empty string`);
    }
    if (typeof item.query !== 'string' || item.query.trim().length === 0) {
      throw new Error(`Invalid links file item at index ${i} in ${filePath}: "query" must be a non-empty string`);
    }
  }

  return parsed;
}

function appendLinks(linksDir, entries) {
  const absDir = path.resolve(linksDir);
  ensureDir(absDir);

  const filePath = path.join(absDir, LINKS_FILENAME);
  const existing = readLinksFile(filePath);

  const keyOf = (e) => `${e.query}\n${e.url}`;
  const seen = new Set(existing.map(keyOf));

  let appended = 0;
  for (const e of entries) {
    const key = keyOf(e);
    if (seen.has(key)) continue;
    existing.push(e);
    seen.add(key);
    appended++;
  }

  fs.writeFileSync(filePath, `${JSON.stringify(existing, null, 2)}\n`, 'utf-8');
  return { filePath, appended };
}


// ============================================================
//  GOOGLE SEARCH CLASS
// ============================================================

class GoogleSearch {
  /** @type {import('../utils/browserUse')|null} */
  _browser = null;

  /** @type {boolean} */
  _ownsInstance = false;

  /** @type {number} Index of the tab holding search results. */
  _resultsTabIndex = -1;

  /** @type {Array<{index:number,title:string,url:string,snippet:string}>} */
  _links = [];

  /** @type {string|null} Last search query (used for persistence). */
  _lastQuery = null;

  /** @type {string|null} URL of a PDF link opened via openLink() (consumed by getContent). */
  _pendingPdfUrl = null;

  /** @type {object} Browser init options. */
  _options = {};

  /** @type {string|null} Directory to persist links.json into. */
  _linksDir = null;

  /**
   * @param {object} [options]
   * @param {import('../utils/browserUse')} [options.browser]  Existing browser instance.
   * @param {boolean|string} [options.cdp]
   * @param {boolean} [options.launch]
   * @param {boolean} [options.headless]
   * @param {number}  [options.timeout]
   * @param {string}  [options.linksDir]  Persist search results into <linksDir>/links.json
   */
  constructor(options = {}) {
    const { linksDir, ...browserOptions } = options;
    this._options = browserOptions;
    this._linksDir = linksDir ? path.resolve(String(linksDir)) : null;
  }

  /** @returns {import('../utils/browserUse')} */
  get browser() { return this._browser; }

  /** @returns {Array} Last parsed organic links. */
  get links() { return this._links; }

  /**
   * Initialise the browser connection.
   * @returns {Promise<GoogleSearch>}
   */
  async init() {
    const { browser, ownsInstance } = await initBrowser(this._options);
    this._browser = browser;
    this._ownsInstance = ownsInstance;
    return this;
  }

  // ---- Search flow ----

  /**
   * Navigate to Google and perform a search.
   * Combines: open → fill → submit → wait for results.
   *
   * @param {string} query  Search query.
   * @param {object} [options]
   * @param {number} [options.timeout=30000]
   * @returns {Promise<void>}
   */
  async search(query, options = {}) {
    const timeout = options.timeout || this._options.timeout || 30000;
    this._ensureBrowser();

    this._lastQuery = query;
    await this._browser.goto(GOOGLE.url, { timeout });
    await this._browser.waitFor(GOOGLE.searchInput, { state: 'visible', timeout });
    await this._browser.fill(GOOGLE.searchInput, query);
    await this._browser.press(GOOGLE.searchInput, 'Enter');
    await this._browser.waitForLoadState('domcontentloaded');

    this._resultsTabIndex = this._getActiveTabIndex();
  }

  /**
   * Get the search form of the current page (delegates to getForms).
   * @returns {Promise<object|null>}  The search-type form or null.
   */
  async getSearchForm() {
    this._ensureBrowser();
    const { forms } = await getForms({ browser: this._browser });
    return forms.find(f => f.type === 'search') || null;
  }

  /**
   * Parse organic search result links from the current page (no ads).
   *
   * If Google returns redirect URLs like https://www.google.com/url?...,
   * this method extracts the real target URL.
   *
   * If linksDir was provided, results are appended to <linksDir>/links.json.
   *
   * @param {object} [options]
   * @param {string} [options.query] Override stored query (used for persistence).
   * @returns {Promise<Array<{index:number, title:string, url:string, snippet:string}>>}
   */
  async getLinks(options = {}) {
    this._ensureBrowser();

    this._links = await this._browser.evaluate(({ selectors }) => {
      const adContainers = document.querySelectorAll(selectors.adContainers);
      const adSet = new Set();
      adContainers.forEach(ad => adSet.add(ad));

      const isInsideAd = (el) => {
        for (const ad of adSet) {
          if (ad.contains(el)) return true;
        }
        return false;
      };

      const results = [];
      const seen = new Set();

      const isHttpUrl = (u) => /^https?:\/\//i.test(u);

      const resolveGoogleRedirect = (href) => {
        try {
          const u = new URL(href);
          const host = (u.hostname || '').toLowerCase();
          const isGoogleHost = host === 'www.google.com' || host === 'google.com' || host.endsWith('.google.com');

          if (isGoogleHost && (u.pathname === '/aclk' || u.pathname.startsWith('/pagead/'))) {
            return null; // ads / tracking
          }

          if (isGoogleHost && u.pathname === '/url') {
            const target = u.searchParams.get('url')
              || u.searchParams.get('q')
              || u.searchParams.get('uddg');
            if (target && isHttpUrl(target)) return target;
          }

          return href;
        } catch {
          return href;
        }
      };

      const anchors = document.querySelectorAll(selectors.resultAnchor);
      anchors.forEach(a => {
        if (isInsideAd(a)) return;

        const rawHref = a.href;
        if (!rawHref) return;

        const resolved = resolveGoogleRedirect(rawHref);
        if (!resolved) return;
        if (!isHttpUrl(resolved)) return;
        if (seen.has(resolved)) return;

        const h3 = a.querySelector(selectors.resultTitle)
          || a.closest(selectors.resultBlock)?.querySelector(selectors.resultTitle);
        if (!h3) return;

        seen.add(resolved);

        const block = a.closest(selectors.resultBlock);
        const snippetEl = block?.querySelector(selectors.resultSnippet);
        const snippet = snippetEl ? snippetEl.textContent.trim() : '';

        results.push({
          index: results.length,
          title: h3.textContent.trim(),
          url: resolved,
          snippet,
        });
      });

      return results;
    }, { selectors: GOOGLE });

    if (this._linksDir) {
      const query = (options.query ?? this._lastQuery ?? '').trim();
      if (!query) {
        throw new Error('Cannot persist links.json: search query is unknown. Call search(query) first or pass getLinks({ query }).');
      }

      const entries = this._links.map(l => ({
        query,
        url: l.url,
        ...(l.title ? { title: l.title } : {}),
        ...(l.snippet ? { description: l.snippet } : {}),
        type: inferLinkType(l.url),
      }));

      appendLinks(this._linksDir, entries);
    }

    return this._links;
  }

  /**
   * Open the n-th link from getLinks() results in a new tab.
   * PDF links are detected but still open a tab (getContent handles extraction).
   *
   * @param {number} n  Zero-based index into the links array.
   * @param {object} [options]
   * @param {number} [options.timeout=30000]
   * @returns {Promise<{url: string, isPdf: boolean}>}
   */
  async openLink(n, options = {}) {
    this._ensureBrowser();
    const timeout = options.timeout || this._options.timeout || 30000;

    if (this._links.length === 0) {
      throw new Error('No links available. Call getLinks() first.');
    }
    if (n < 0 || n >= this._links.length) {
      throw new RangeError(`Link index ${n} out of range [0..${this._links.length - 1}]`);
    }

    const linkUrl = this._links[n].url;
    const pdf = isPdfUrl(linkUrl);

    this._resultsTabIndex = this._getActiveTabIndex();
    this._pendingPdfUrl = pdf ? linkUrl : null;

    await this._browser.newPage();

    if (!pdf) {
      await this._browser.goto(linkUrl, { timeout });
      try {
        await this._browser.waitForLoadState('networkidle', { timeout: 5000 });
      } catch { /* proceed if network doesn't idle */ }
    }

    return { url: linkUrl, isPdf: pdf };
  }

  /**
   * Get Markdown content of the currently active tab (delegates to getContent).
   *
   * @param {object} options
   * @param {string} options.dir   Output directory.
   * @param {string} options.name  Output filename.
   * @param {string} [options.imageSubdir='images']
   * @param {number} [options.minWidth=100]
   * @param {number} [options.minHeight=100]
   * @returns {Promise<{markdown:string, images:Array, savedTo:string, metadata:object}>}
   */
  async getContent(options) {
    this._ensureBrowser();
    const pdfUrl = this._pendingPdfUrl;
    this._pendingPdfUrl = null;
    return getContent({
      browser: this._browser,
      ...(pdfUrl ? { url: pdfUrl } : {}),
      ...options,
    });
  }

  /**
   * Close the current tab and switch back to the search results tab.
   * @returns {Promise<void>}
   */
  async closeTab() {
    this._ensureBrowser();
    await this._browser.closePage();

    const pages = this._browser.getPages();
    const targetIdx = Math.min(this._resultsTabIndex, pages.length - 1);
    if (targetIdx >= 0 && pages.length > 0) {
      await this._browser.switchToPage(targetIdx);
    }
  }

  /**
   * Navigate to the n-th pagination page of Google results.
   * If n is omitted or 0, clicks the "Next" link.
   *
   * @param {number} [n]  Page number (1-based). 0 or undefined = next page.
   * @param {object} [options]
   * @param {number} [options.timeout=30000]
   * @returns {Promise<void>}
   */
  async goToPage(n, options = {}) {
    this._ensureBrowser();
    const timeout = options.timeout || this._options.timeout || 30000;

    if (!n) {
      await this._browser.click(GOOGLE.nextPage);
    } else {
      const selector = GOOGLE.paginationLink.replace(/\{n\}/g, String(n));
      await this._browser.click(selector);
    }

    await this._browser.waitForLoadState('domcontentloaded');
    this._links = [];
  }

  /**
   * Close the browser (only if this instance owns it).
   * @returns {Promise<void>}
   */
  async close() {
    await releaseBrowser(this._browser, this._ownsInstance);
    this._browser = null;
  }

  // ---- Private helpers ----

  _ensureBrowser() {
    if (!this._browser) {
      throw new Error('Browser not initialized. Call init() first.');
    }
  }

  _getActiveTabIndex() {
    const pages = this._browser.getPages();
    const activePage = this._browser.page;
    return pages.indexOf(activePage);
  }
}


// ============================================================
//  EXPORTS
// ============================================================

module.exports = GoogleSearch;
module.exports.GoogleSearch = GoogleSearch;
module.exports.GOOGLE_SELECTORS = GOOGLE;


// ============================================================
//  CLI
// ============================================================

if (require.main === module) {
  const HELP = `
Usage: node scripts/googleSearch.js "<query>" [options]

Options:
  --page <n>              Go to pagination page n after search
  --links                 Print organic links as JSON
  --open <n>              Open the n-th link (0-based) and get content
  --dir <dir>             Output directory for content (required with --open). If set, also appends results to <dir>/links.json
  --name <file>           Filename for content (required with --open)
  --image-subdir <dir>    Subdirectory for images (default: images)
  --profile <name>        Chrome profile name (default: AgentProfile)
  --cdp [endpoint]        Connect via CDP (default: http://localhost:9222)
  --launch                Force launch a new browser
  --headless              Run headless
  --timeout <ms>          Timeout (default: 30000)
  --help                  Show this help

Examples:
  node scripts/googleSearch.js "node.js best practices" --links
  node scripts/googleSearch.js "node.js best practices" --links --dir ./archive/my-research   # also writes ./archive/my-research/links.json
  node scripts/googleSearch.js "playwright tutorial" --open 0 --dir ./output --name article.md
  node scripts/googleSearch.js "web scraping" --page 2 --links
`.trim();

  (async () => {
    const argv = process.argv.slice(2);

    if (argv.includes('--help') || argv.length === 0) {
      console.log(HELP);
      process.exit(0);
    }

    const flags = parseBaseFlags(argv);
    const extra = parseGoogleFlags(argv);

    if (!extra.query) {
      console.error('Error: search query is required as the first positional argument.');
      process.exit(1);
    }

    const google = new GoogleSearch({
      ...flagsToBrowserOptions(flags),
      ...(extra.dir ? { linksDir: extra.dir } : {}),
    });
    await google.init();

    try {
      console.error(`Searching: "${extra.query}"...`);
      await google.search(extra.query);

      if (extra.page) {
        console.error(`Navigating to page ${extra.page}...`);
        await google.goToPage(extra.page);
      }

      if (extra.printLinks || extra.open != null) {
        const links = await google.getLinks();
        console.error(`Found ${links.length} organic links.`);

        if (extra.printLinks) {
          console.log(JSON.stringify(links, null, 2));
        }

        if (extra.open != null) {
          if (!extra.dir || !extra.name) {
            console.error('Error: --dir and --name are required when using --open.');
            process.exit(1);
          }

          console.error(`Opening link #${extra.open}: ${links[extra.open]?.url || '(unknown)'}...`);
          await google.openLink(extra.open);

          const result = await google.getContent({
            dir: extra.dir,
            name: extra.name,
            imageSubdir: extra.imageSubdir,
          });

          const okImages = result.images.filter(r => r.success).length;
          console.error(`Content saved to: ${result.savedTo}`);
          console.error(`Markdown: ${result.markdown.length} chars, images: ${okImages}`);

          await google.closeTab();
        }
      } else {
        const links = await google.getLinks();
        console.log(JSON.stringify(links, null, 2));
        console.error(`Found ${links.length} organic links.`);
      }
    } finally {
      await google.close();
    }
  })().catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}

function parseGoogleFlags(argv) {
  const flags = {
    query: null,
    page: null,
    printLinks: false,
    open: null,
    dir: null,
    name: null,
    imageSubdir: 'images',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--page') flags.page = parseInt(argv[++i], 10) || null;
    else if (arg === '--links') flags.printLinks = true;
    else if (arg === '--open') flags.open = parseInt(argv[++i], 10);
    else if (arg === '--dir') flags.dir = argv[++i];
    else if (arg === '--name') flags.name = argv[++i];
    else if (arg === '--image-subdir') flags.imageSubdir = argv[++i];
    else if (!arg.startsWith('--') && flags.query === null) flags.query = arg;
  }

  return flags;
}
