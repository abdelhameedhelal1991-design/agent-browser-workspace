'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const http = require('http');

// ============================================================
//  CONSTANTS
// ============================================================

const DEFAULT_CDP_ENDPOINT = 'http://localhost:9222';
const DEFAULT_CDP_PORT = 9222;
const DEFAULT_PROFILE = 'AgentProfile';

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

const DEFAULT_GOTO_OPTIONS = {
  waitUntil: 'load',
  timeout: 30000,
};

const LAUNCH_COMMANDS = {
  win32: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"',
  darwin: '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"',
  linux: 'google-chrome',
};

// ============================================================
//  HELPERS
// ============================================================

function getDefaultUserDataDir(profile = DEFAULT_PROFILE) {
  switch (process.platform) {
    case 'win32':
      return path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
        'Google', 'Chrome', profile,
      );
    case 'darwin':
      return path.join(
        os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', profile,
      );
    default:
      return path.join(os.homedir(), '.config', 'google-chrome', profile);
  }
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function sanitizeFilename(raw) {
  let name = raw.replace(/[?#].*$/, '');
  try { name = decodeURIComponent(path.basename(name)); } catch { name = path.basename(name); }
  name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  name = name.replace(/_{2,}/g, '_');
  name = name.replace(/^[.\s]+|[.\s]+$/g, '');
  return name.substring(0, 200) || 'image';
}

function resolveImageExtension(contentType) {
  if (!contentType) return '.jpg';
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('gif')) return '.gif';
  if (contentType.includes('webp')) return '.webp';
  if (contentType.includes('svg')) return '.svg';
  if (contentType.includes('avif')) return '.avif';
  if (contentType.includes('bmp')) return '.bmp';
  if (contentType.includes('ico') || contentType.includes('icon')) return '.ico';
  return '.jpg';
}

function isPdfUrl(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return pathname.endsWith('.pdf');
  } catch {
    return url.toLowerCase().endsWith('.pdf');
  }
}

function deduplicatePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;

  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  let counter = 1;
  let candidate;
  do {
    candidate = path.join(dir, `${base}_${counter}${ext}`);
    counter++;
  } while (fs.existsSync(candidate));

  return candidate;
}

/**
 * Returns shell command to launch Chrome with CDP for manual startup.
 * @param {object} [opts]
 * @param {number} [opts.port=9222]
 * @param {string} [opts.profile]      Profile name (default: AgentProfile).
 * @param {string} [opts.userDataDir]  Full path (overrides profile).
 * @returns {string}
 */
function getCdpLaunchCommand(opts = {}) {
  const port = opts.port || 9222;
  const userDataDir = opts.userDataDir || getDefaultUserDataDir(opts.profile);
  const exe = LAUNCH_COMMANDS[process.platform] || LAUNCH_COMMANDS.linux;
  return `${exe} --remote-debugging-port=${port} --user-data-dir="${userDataDir}"`;
}

function findChromeExecutable() {
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    throw new Error(`Chrome executable not found. Checked:\n${candidates.join('\n')}`);
  }
  if (process.platform === 'darwin') {
    const p = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(p)) return p;
    throw new Error(`Chrome executable not found at: ${p}`);
  }
  return 'google-chrome';
}

function waitForCDP(endpoint, timeout) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function attempt() {
      if (Date.now() - start > timeout) {
        return reject(new Error(`CDP endpoint ${endpoint} not ready after ${timeout}ms`));
      }
      const req = http.get(`${endpoint}/json/version`, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve(data));
      });
      req.on('error', () => setTimeout(attempt, 250));
      req.setTimeout(2000, () => { req.destroy(); setTimeout(attempt, 250); });
    })();
  });
}

function killProcess(pid) {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGTERM');
    }
  } catch { /* already dead */ }
}


// ============================================================
//  BROWSER USE CLASS
// ============================================================

class BrowserUse {
  /** @type {import('playwright').Browser|null} */
  _browser = null;

  /** @type {import('playwright').BrowserContext|null} */
  _context = null;

  /** @type {import('playwright').Page|null} */
  _page = null;

  /** @type {'persistent'|'cdp'|null} */
  _mode = null;

  /** @type {import('child_process').ChildProcess|null} */
  _childProcess = null;

  // ---- Accessors ----

  get browser() { return this._browser; }
  get context() { return this._context; }
  get page() { return this._page; }
  get mode() { return this._mode; }

  // ---- Static factories ----

  /** Launch Chrome with a persistent profile and return a ready instance. */
  static async launch(options) {
    const instance = new BrowserUse();
    await instance.launch(options);
    return instance;
  }

  /** Connect to an existing Chrome via CDP and return a ready instance. */
  static async connectCDP(options) {
    const instance = new BrowserUse();
    await instance.connectCDP(options);
    return instance;
  }

  /** Launch Chrome with CDP in background and return a ready instance. */
  static async launchCDP(options) {
    const instance = new BrowserUse();
    await instance.launchCDP(options);
    return instance;
  }

  /**
   * Shut down Chrome running on a CDP port.
   * @param {object} [opts]
   * @param {number} [opts.port=9222]
   */
  static async shutdown(opts = {}) {
    const port = opts.port || DEFAULT_CDP_PORT;
    const endpoint = `http://localhost:${port}`;
    try {
      const b = await chromium.connectOverCDP(endpoint, { timeout: 5000 });
      const session = await b.newBrowserCDPSession();
      await session.send('Browser.close');
      await b.close().catch(() => {});
    } catch { /* not running */ }
  }

  /**
   * @param {string} [profile] Profile name (default: AgentProfile).
   * @returns {string} User-data-dir path for the given profile.
   */
  static getDefaultUserDataDir(profile) {
    return getDefaultUserDataDir(profile);
  }

  /**
   * Returns the shell command to start Chrome with --remote-debugging-port.
   * @param {object} [opts]
   * @param {number} [opts.port=9222]
   * @param {string} [opts.profile]      Profile name (default: AgentProfile).
   * @param {string} [opts.userDataDir]  Full path (overrides profile).
   */
  static getCdpLaunchCommand(opts) {
    return getCdpLaunchCommand(opts);
  }

  // ---- Initialization ----

  /**
   * Launch a real Chrome with a persistent user profile.
   *
   * @param {object} [options]
   * @param {string}  [options.profile]            Profile name (default: AgentProfile).
   * @param {string}  [options.userDataDir]        Full profile path (overrides profile).
   * @param {boolean} [options.headless=false]      Run headless.
   * @param {string}  [options.channel='chrome']    Browser channel.
   * @param {{width:number,height:number}} [options.viewport]
   * @param {boolean} [options.acceptDownloads=true]
   * @param {string[]} [options.args]               Extra Chromium flags.
   * @returns {Promise<BrowserUse>}
   */
  async launch(options = {}) {
    if (this._context) {
      throw new Error('Browser already initialized. Call close() first.');
    }

    const {
      profile,
      userDataDir = getDefaultUserDataDir(profile),
      headless = false,
      channel = 'chrome',
      viewport = DEFAULT_VIEWPORT,
      acceptDownloads = true,
      args = [],
      ...rest
    } = options;

    ensureDir(userDataDir);

    this._context = await chromium.launchPersistentContext(userDataDir, {
      channel,
      headless,
      viewport,
      acceptDownloads,
      args,
      ...rest,
    });

    const pages = this._context.pages();
    this._page = pages.length > 0 ? pages[0] : await this._context.newPage();
    this._mode = 'persistent';

    return this;
  }

  /**
   * Attach to an already-running Chrome via Chrome DevTools Protocol.
   *
   * Start Chrome manually:
   *   Windows:  "C:\Program Files\Google\Chrome\Application\chrome.exe"
   *             --remote-debugging-port=9222
   *             --user-data-dir="%LOCALAPPDATA%\Google\Chrome\AgentProfile"
   *   macOS:    /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome
   *             --remote-debugging-port=9222
   *             --user-data-dir="$HOME/Library/Application Support/Google/Chrome/AgentProfile"
   *   Linux:    google-chrome --remote-debugging-port=9222
   *             --user-data-dir="$HOME/.config/google-chrome/AgentProfile"
   *
   * @param {object} [options]
   * @param {string} [options.endpointURL='http://localhost:9222']
   * @param {number} [options.timeout=30000]
   * @returns {Promise<BrowserUse>}
   */
  async connectCDP(options = {}) {
    if (this._context) {
      throw new Error('Browser already initialized. Call close() first.');
    }

    const {
      endpointURL = DEFAULT_CDP_ENDPOINT,
      timeout = 30000,
    } = options;

    this._browser = await chromium.connectOverCDP(endpointURL, { timeout });

    const contexts = this._browser.contexts();
    this._context = contexts.length > 0 ? contexts[0] : null;

    if (!this._context) {
      throw new Error(
        'No browser context found on CDP endpoint. '
        + 'Make sure Chrome is running with --remote-debugging-port.',
      );
    }

    const pages = this._context.pages();
    this._page = pages.length > 0 ? pages[0] : await this._context.newPage();
    this._mode = 'cdp';

    return this;
  }

  /**
   * Launch Chrome as a background process with --remote-debugging-port,
   * then connect via CDP. Chrome persists after close() — use shutdown()
   * or BrowserUse.shutdown() to terminate it.
   *
   * If Chrome is already listening on the port, connects without spawning.
   *
   * @param {object} [options]
   * @param {number}  [options.port=9222]            CDP port.
   * @param {string}  [options.profile]              Profile name (default: AgentProfile).
   * @param {string}  [options.userDataDir]          Full profile path (overrides profile).
   * @param {boolean} [options.headless=false]       Headless mode.
   * @param {number}  [options.timeout=30000]        Timeout for startup + connection.
   * @param {string[]} [options.args]                Extra Chromium flags.
   * @returns {Promise<BrowserUse>}
   */
  async launchCDP(options = {}) {
    if (this._context) {
      throw new Error('Browser already initialized. Call close() first.');
    }

    const {
      port = DEFAULT_CDP_PORT,
      profile,
      userDataDir = getDefaultUserDataDir(profile),
      headless = false,
      timeout = 30000,
      args = [],
    } = options;

    const endpoint = `http://localhost:${port}`;

    try {
      await waitForCDP(endpoint, 2000);
      await this.connectCDP({ endpointURL: endpoint, timeout });
      return this;
    } catch {
      // Not running — launch below
    }

    ensureDir(userDataDir);
    const exe = findChromeExecutable();

    const chromeArgs = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      ...args,
    ];
    if (headless) chromeArgs.push('--headless=new');

    const child = spawn(exe, chromeArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    this._childProcess = child;

    try {
      await waitForCDP(endpoint, timeout);
      await this.connectCDP({ endpointURL: endpoint, timeout });
    } catch (err) {
      this._killProcess();
      throw err;
    }

    return this;
  }

  // ---- Tab / page management ----

  /** Open a new tab and make it the active page. */
  async newPage() {
    this._ensureContext();
    this._page = await this._context.newPage();
    return this._page;
  }

  /** Switch to an existing tab by index. */
  async switchToPage(index) {
    this._ensureContext();
    const pages = this._context.pages();
    if (index < 0 || index >= pages.length) {
      throw new RangeError(`Page index ${index} out of range [0..${pages.length - 1}]`);
    }
    this._page = pages[index];
    return this._page;
  }

  /** @returns {import('playwright').Page[]} All open pages in the context. */
  getPages() {
    this._ensureContext();
    return this._context.pages();
  }

  /** Close the current tab and switch to the last remaining one. */
  async closePage() {
    this._ensurePage();
    await this._page.close();
    const pages = this._context.pages();
    this._page = pages.length > 0 ? pages[pages.length - 1] : null;
  }

  // ---- Navigation ----

  /**
   * Navigate to a URL.
   * @param {string} url
   * @param {object} [options]  Playwright goto options (waitUntil, timeout, referer).
   * @returns {Promise<import('playwright').Response|null>}
   */
  async goto(url, options = {}) {
    this._ensurePage();
    return this._page.goto(url, { ...DEFAULT_GOTO_OPTIONS, ...options });
  }

  async goBack(options = {}) {
    this._ensurePage();
    return this._page.goBack(options);
  }

  async goForward(options = {}) {
    this._ensurePage();
    return this._page.goForward(options);
  }

  async reload(options = {}) {
    this._ensurePage();
    return this._page.reload(options);
  }

  /**
   * Navigate to a URL and wait for JS-rendered content to be ready.
   * Combines goto (load) → networkidle → DOM content stabilization.
   *
   * Use instead of goto() for pages that render content via JavaScript
   * (SPAs, dynamic pages, lazy-loaded content). Falls back gracefully
   * if networkidle or stabilization times out.
   *
   * @param {string} url
   * @param {object} [options]
   * @param {number}  [options.timeout=30000]           Navigation timeout (ms).
   * @param {number}  [options.networkIdleTimeout=5000]  Max time to wait for networkidle after load (ms).
   * @param {number}  [options.contentTimeout=15000]     Max time to wait for content stabilization (ms).
   * @param {string}  [options.waitForSelector]          CSS selector to wait for before stabilization check.
   * @param {number}  [options.pollInterval=300]         Content stabilization poll interval (ms).
   * @param {number}  [options.stableCount=3]            Consecutive stable readings to consider content ready.
   * @returns {Promise<{response: import('playwright').Response|null, contentReady: {stable:boolean, contentLength:number, elapsed:number}}>}
   */
  async gotoAndWaitForContent(url, options = {}) {
    this._ensurePage();

    const {
      timeout = 30000,
      networkIdleTimeout = 5000,
      contentTimeout = 15000,
      waitForSelector,
      pollInterval = 300,
      stableCount = 3,
    } = options;

    const response = await this._page.goto(url, {
      waitUntil: 'load',
      timeout,
    });

    try {
      await this._page.waitForLoadState('networkidle', { timeout: networkIdleTimeout });
    } catch { /* network didn't idle — proceed */ }

    if (waitForSelector) {
      try {
        await this._page.locator(waitForSelector).waitFor({
          state: 'visible',
          timeout: contentTimeout,
        });
      } catch { /* selector not found — proceed */ }
    }

    const contentReady = await this.waitForContentReady({
      pollInterval,
      stableCount,
      timeout: contentTimeout,
    });

    return { response, contentReady };
  }

  // ---- Page state ----

  /** @returns {string} Current page URL. */
  getUrl() {
    this._ensurePage();
    return this._page.url();
  }

  /** @returns {Promise<string>} Page title. */
  async getTitle() {
    this._ensurePage();
    return this._page.title();
  }

  /** @returns {Promise<string>} Full HTML of the current page (including <!DOCTYPE>). */
  async getHtml() {
    this._ensurePage();
    return this._page.content();
  }

  /**
   * Get innerHTML of an element matched by CSS/XPath selector.
   * @param {string} selector
   */
  async getElementHtml(selector) {
    this._ensurePage();
    return this._page.locator(selector).innerHTML();
  }

  /**
   * Get textContent of an element.
   * @param {string} selector
   */
  async getText(selector) {
    this._ensurePage();
    return this._page.locator(selector).textContent();
  }

  /** Get attribute value of an element. */
  async getAttribute(selector, attribute) {
    this._ensurePage();
    return this._page.locator(selector).getAttribute(attribute);
  }

  // ---- Waiting ----

  /**
   * Wait for an element to appear.
   * @param {string} selector
   * @param {object} [options]  state: 'attached'|'detached'|'visible'|'hidden', timeout.
   */
  async waitFor(selector, options = {}) {
    this._ensurePage();
    return this._page.locator(selector).waitFor(options);
  }

  /**
   * Wait until the page URL matches a pattern.
   * @param {string|RegExp|((url:URL)=>boolean)} urlPattern
   */
  async waitForUrl(urlPattern, options = {}) {
    this._ensurePage();
    return this._page.waitForURL(urlPattern, options);
  }

  /**
   * @param {'load'|'domcontentloaded'|'networkidle'} [state='domcontentloaded']
   * @param {object} [options]
   * @param {number} [options.timeout]  Timeout in ms.
   */
  async waitForLoadState(state = 'domcontentloaded', options = {}) {
    this._ensurePage();
    return this._page.waitForLoadState(state, options);
  }

  /**
   * Wait for a network response matching a URL pattern.
   * @param {string|RegExp|((resp:import('playwright').Response)=>boolean)} urlPattern
   */
  async waitForResponse(urlPattern, options = {}) {
    this._ensurePage();
    return this._page.waitForResponse(urlPattern, options);
  }

  /**
   * Wait a fixed number of milliseconds (use sparingly).
   * @param {number} ms
   */
  async wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Wait for page content to stabilize after JS rendering.
   * Polls document.body.innerText length and considers content "ready"
   * when it stops changing between consecutive checks.
   *
   * Useful after goto() on JS-heavy / SPA pages where HTML may be
   * initially empty and then populated by client-side scripts.
   *
   * @param {object} [options]
   * @param {number} [options.pollInterval=300]  Interval between checks (ms).
   * @param {number} [options.stableCount=3]     Consecutive stable readings required.
   * @param {number} [options.timeout=15000]     Max wait time (ms).
   * @returns {Promise<{stable: boolean, contentLength: number, elapsed: number}>}
   */
  async waitForContentReady(options = {}) {
    this._ensurePage();

    const {
      pollInterval = 300,
      stableCount = 3,
      timeout = 15000,
    } = options;

    const start = Date.now();
    let previousLength = -1;
    let stableReadings = 0;

    while (Date.now() - start < timeout) {
      const currentLength = await this._page.evaluate(
        () => (document.body ? document.body.innerText.length : 0),
      );

      if (currentLength === previousLength && currentLength > 0) {
        stableReadings++;
        if (stableReadings >= stableCount) {
          return { stable: true, contentLength: currentLength, elapsed: Date.now() - start };
        }
      } else {
        stableReadings = 0;
      }

      previousLength = currentLength;
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    return {
      stable: false,
      contentLength: previousLength,
      elapsed: Date.now() - start,
    };
  }

  // ---- Interactions ----

  /** Click an element. */
  async click(selector, options = {}) {
    this._ensurePage();
    await this._page.locator(selector).click(options);
  }

  /** Double-click an element. */
  async dblclick(selector, options = {}) {
    this._ensurePage();
    await this._page.locator(selector).dblclick(options);
  }

  /** Hover over an element. */
  async hover(selector, options = {}) {
    this._ensurePage();
    await this._page.locator(selector).hover(options);
  }

  /**
   * Fill a single input field (clears existing value first).
   * @param {string} selector
   * @param {string} value
   */
  async fill(selector, value) {
    this._ensurePage();
    await this._page.locator(selector).fill(value);
  }

  /**
   * Type text character-by-character (triggers keydown/keyup per char).
   * Useful for inputs with autocomplete / search-as-you-type.
   * @param {string} selector
   * @param {string} text
   * @param {object} [options]  delay (ms between keystrokes).
   */
  async type(selector, text, options = {}) {
    this._ensurePage();
    await this._page.locator(selector).pressSequentially(text, options);
  }

  /**
   * Fill a form: auto-detects input type (text, select, checkbox, radio, file).
   *
   * @param {Object<string,*>} fields  { selector: value, ... }
   *
   * @example
   *   await browser.fillForm({
   *     '#email':    'user@example.com',
   *     '#password': 'secret',
   *     '#country':  'US',           // <select> → selectOption
   *     '#agree':    true,           // checkbox → check / uncheck
   *     '#avatar':   './photo.jpg',  // file    → setInputFiles
   *   });
   */
  async fillForm(fields) {
    this._ensurePage();

    for (const [selector, value] of Object.entries(fields)) {
      const locator = this._page.locator(selector);

      const info = await locator.evaluate(el => ({
        tag: el.tagName.toLowerCase(),
        type: (el.type || '').toLowerCase(),
      }));

      if (info.tag === 'select') {
        await locator.selectOption(value);
      } else if (info.type === 'checkbox' || info.type === 'radio') {
        if (value) await locator.check();
        else await locator.uncheck();
      } else if (info.type === 'file') {
        await locator.setInputFiles(value);
      } else {
        await locator.fill(String(value));
      }
    }
  }

  /** Select an option from a <select> element. */
  async select(selector, value) {
    this._ensurePage();
    await this._page.locator(selector).selectOption(value);
  }

  /** Check a checkbox or radio button. */
  async check(selector) {
    this._ensurePage();
    await this._page.locator(selector).check();
  }

  /** Uncheck a checkbox. */
  async uncheck(selector) {
    this._ensurePage();
    await this._page.locator(selector).uncheck();
  }

  /**
   * Press a keyboard key in the context of an element.
   * @param {string} selector
   * @param {string} key  e.g. 'Enter', 'Tab', 'Control+a', 'Backspace'.
   */
  async press(selector, key) {
    this._ensurePage();
    await this._page.locator(selector).press(key);
  }

  /**
   * Upload one or more files via a file input.
   * @param {string} selector
   * @param {string|string[]} filePaths
   */
  async uploadFile(selector, filePaths) {
    this._ensurePage();
    await this._page.locator(selector).setInputFiles(filePaths);
  }

  // ---- Scrolling ----

  /**
   * Scroll the page. Supports directional scrolling, pixel offsets,
   * element targeting, and repeated scrolling for infinite-scroll pages.
   *
   * When `times > 1`, pauses `delay` ms between iterations and stops early
   * if the page height and scroll position stay unchanged (bottom reached).
   *
   * @param {object} [options]
   * @param {'down'|'up'|'top'|'bottom'} [options.direction='down']
   *   'down'/'up' — scroll by one viewport height (or `distance` pixels).
   *   'top'/'bottom' — jump to the absolute start/end of the page.
   * @param {number}  [options.distance]       Pixels to scroll (overrides viewport-based step).
   * @param {string}  [options.selector]       Scroll until this element is in view (overrides direction/distance).
   * @param {number}  [options.times=1]        Number of scroll iterations (useful for infinite scroll).
   * @param {number}  [options.delay=1000]     Pause between iterations (ms) for dynamic content to load.
   * @param {number}  [options.timeout=30000]  Max total time (ms); stops early if exceeded.
   * @returns {Promise<{scrollTop:number, scrollHeight:number, reachedBottom:boolean, iterations:number}>}
   */
  async scroll(options = {}) {
    this._ensurePage();

    const {
      direction = 'down',
      distance,
      selector,
      times = 1,
      delay = 1000,
      timeout = 30000,
    } = options;

    if (selector) {
      await this._page.locator(selector).scrollIntoViewIfNeeded();
      const pos = await this._page.evaluate(() => {
        const st = document.documentElement.scrollTop || document.body.scrollTop;
        const sh = document.documentElement.scrollHeight;
        const vh = window.innerHeight;
        return { scrollTop: st, scrollHeight: sh, viewportHeight: vh };
      });
      return {
        scrollTop: pos.scrollTop,
        scrollHeight: pos.scrollHeight,
        reachedBottom: pos.scrollTop + pos.viewportHeight >= pos.scrollHeight - 1,
        iterations: 1,
      };
    }

    const start = Date.now();
    let iterations = 0;
    let reachedBottom = false;

    for (let i = 0; i < times; i++) {
      if (Date.now() - start > timeout) break;

      const before = await this._page.evaluate(() => ({
        scrollTop: document.documentElement.scrollTop || document.body.scrollTop,
        scrollHeight: document.documentElement.scrollHeight,
      }));

      await this._page.evaluate(({ dir, dist }) => {
        if (dir === 'top') {
          window.scrollTo(0, 0);
        } else if (dir === 'bottom') {
          window.scrollTo(0, document.documentElement.scrollHeight);
        } else {
          const delta = dist || window.innerHeight;
          window.scrollBy(0, dir === 'up' ? -delta : delta);
        }
      }, { dir: direction, dist: distance });

      iterations++;

      if (times > 1) {
        await new Promise(resolve => setTimeout(resolve, delay));

        const after = await this._page.evaluate(() => ({
          scrollTop: document.documentElement.scrollTop || document.body.scrollTop,
          scrollHeight: document.documentElement.scrollHeight,
        }));

        if (
          after.scrollTop === before.scrollTop
          && after.scrollHeight === before.scrollHeight
          && (direction === 'down' || direction === 'bottom')
        ) {
          reachedBottom = true;
          break;
        }
      }
    }

    const final = await this._page.evaluate(() => {
      const st = document.documentElement.scrollTop || document.body.scrollTop;
      const sh = document.documentElement.scrollHeight;
      const vh = window.innerHeight;
      return { scrollTop: st, scrollHeight: sh, viewportHeight: vh };
    });

    return {
      scrollTop: final.scrollTop,
      scrollHeight: final.scrollHeight,
      reachedBottom: reachedBottom
        || (final.scrollTop + final.viewportHeight >= final.scrollHeight - 1),
      iterations,
    };
  }

  // ---- Screenshots ----

  /**
   * Take a screenshot of the page.
   *
   * @param {object} [options]
   * @param {string}  [options.path]              Save to file (directory auto-created).
   * @param {boolean} [options.fullPage=false]     Capture the full scrollable page.
   * @param {'png'|'jpeg'} [options.type='png']
   * @param {number}  [options.quality]            JPEG quality 0-100.
   * @param {object}  [options.clip]               { x, y, width, height } region.
   * @returns {Promise<Buffer>}
   */
  async screenshot(options = {}) {
    this._ensurePage();

    const opts = { type: 'png', ...options };

    if (opts.path) {
      ensureDir(path.dirname(path.resolve(opts.path)));
    }

    return this._page.screenshot(opts);
  }

  /**
   * Take a screenshot of a specific element.
   * @param {string} selector
   * @param {object} [options]  Same as screenshot().
   * @returns {Promise<Buffer>}
   */
  async screenshotElement(selector, options = {}) {
    this._ensurePage();

    const opts = { type: 'png', ...options };

    if (opts.path) {
      ensureDir(path.dirname(path.resolve(opts.path)));
    }

    return this._page.locator(selector).screenshot(opts);
  }

  // ---- Content image downloading ----

  /**
   * Download images found on the current page.
   *
   * @param {object} [options]
   * @param {string} [options.outputDir='./images']  Target directory.
   * @param {string} [options.selector='img']        CSS selector for image elements.
   * @param {number} [options.minWidth=0]            Skip images narrower than this (px).
   * @param {number} [options.minHeight=0]           Skip images shorter than this (px).
   * @param {number} [options.concurrency=5]         Parallel download limit.
   * @returns {Promise<Array<{src:string, alt:string, savedAs:string, size:number, success:boolean, error?:string}>>}
   */
  async downloadImages(options = {}) {
    this._ensurePage();

    const {
      outputDir = './images',
      selector = 'img',
      minWidth = 0,
      minHeight = 0,
      concurrency = 5,
    } = options;

    const absOutputDir = path.resolve(outputDir);
    ensureDir(absOutputDir);

    const images = await this._page.locator(selector).evaluateAll(
      (elements, filters) => elements.map(el => ({
        src: el.currentSrc || el.src
          || el.dataset.src || el.dataset.lazySrc || el.dataset.original || '',
        alt: el.alt || '',
        naturalWidth: el.naturalWidth || 0,
        naturalHeight: el.naturalHeight || 0,
      })).filter(img =>
        img.src
        && !img.src.startsWith('data:')
        && img.naturalWidth >= filters.minWidth
        && img.naturalHeight >= filters.minHeight,
      ),
      { minWidth, minHeight },
    );

    if (images.length === 0) return [];

    const pageUrl = this._page.url();
    const results = [];

    for (let i = 0; i < images.length; i += concurrency) {
      const batch = images.slice(i, i + concurrency);

      const batchResults = await Promise.all(batch.map(async (img) => {
        try {
          const absoluteUrl = new URL(img.src, pageUrl).href;

          const response = await this._page.request.get(absoluteUrl);
          if (!response.ok()) {
            return { src: img.src, alt: img.alt, success: false, error: `HTTP ${response.status()}` };
          }

          const buffer = await response.body();
          const contentType = response.headers()['content-type'] || '';

          let filename = sanitizeFilename(img.src);
          if (!path.extname(filename)) {
            filename += resolveImageExtension(contentType);
          }

          const filePath = deduplicatePath(path.join(absOutputDir, filename));
          fs.writeFileSync(filePath, buffer);

          return {
            src: img.src,
            alt: img.alt,
            savedAs: filePath,
            size: buffer.length,
            success: true,
          };
        } catch (err) {
          return { src: img.src, alt: img.alt, success: false, error: err.message };
        }
      }));

      results.push(...batchResults);
    }

    return results;
  }

  // ---- File downloads ----

  /**
   * Click a trigger element and wait for the browser download to start.
   *
   * @param {string} triggerSelector  Element that initiates the download.
   * @param {object} [options]
   * @param {string} [options.outputDir='./downloads']
   * @param {string} [options.filename]  Override the suggested filename.
   * @returns {Promise<{filename:string, path:string, url:string}>}
   */
  async downloadFile(triggerSelector, options = {}) {
    this._ensurePage();

    const { outputDir = './downloads', filename = null } = options;
    const absOutputDir = path.resolve(outputDir);
    ensureDir(absOutputDir);

    const downloadPromise = this._page.waitForEvent('download');
    await this._page.locator(triggerSelector).click();
    const download = await downloadPromise;

    const name = filename || download.suggestedFilename();
    const filePath = deduplicatePath(path.join(absOutputDir, name));
    await download.saveAs(filePath);

    return { filename: name, path: filePath, url: download.url() };
  }

  // ---- JavaScript evaluation ----

  /**
   * Execute arbitrary JavaScript in the page context.
   * @param {Function|string} pageFunction
   * @param {*} [arg]  Serializable argument passed to the function.
   */
  async evaluate(pageFunction, arg) {
    this._ensurePage();
    return this._page.evaluate(pageFunction, arg);
  }

  // ---- Network utilities ----

  /**
   * Block certain resource types (images, stylesheets, fonts, etc.).
   * @param {string[]} resourceTypes  e.g. ['image', 'stylesheet', 'font', 'media'].
   */
  async blockResources(resourceTypes) {
    this._ensurePage();
    await this._page.route('**/*', route => {
      if (resourceTypes.includes(route.request().resourceType())) {
        return route.abort();
      }
      return route.continue();
    });
  }

  /** Subscribe to outgoing requests. */
  onRequest(callback) {
    this._ensurePage();
    this._page.on('request', callback);
  }

  /** Subscribe to incoming responses. */
  onResponse(callback) {
    this._ensurePage();
    this._page.on('response', callback);
  }

  // ---- PDF handling ----

  /**
   * Download a PDF and extract its text content.
   *
   * Uses the browser's request context (preserves cookies/auth) to download
   * the PDF, then parses it with unpdf. Works even when Chrome extensions
   * (Adobe Acrobat, Google PDF Viewer) intercept PDF navigation.
   *
   * @param {string} url  URL of the PDF file.
   * @param {object} [options]
   * @param {boolean} [options.mergePages=true]  Merge all pages into a single string.
   * @param {string}  [options.saveTo]           Save PDF binary to this path before parsing.
   * @returns {Promise<{text: string|string[], totalPages: number, savedTo?: string}>}
   */
  async getPdfText(url, options = {}) {
    this._ensurePage();

    const { mergePages = true, saveTo } = options;

    const resp = await this._page.request.get(url);
    if (!resp.ok()) {
      throw new Error(`Failed to download PDF: HTTP ${resp.status()} from ${url}`);
    }

    const buffer = await resp.body();

    if (saveTo) {
      ensureDir(path.dirname(path.resolve(saveTo)));
      fs.writeFileSync(saveTo, buffer);
    }

    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buffer));

    try {
      const result = await extractText(pdf, { mergePages });
      return {
        text: result.text,
        totalPages: result.totalPages,
        ...(saveTo ? { savedTo: path.resolve(saveTo) } : {}),
      };
    } finally {
      await pdf.destroy();
    }
  }

  /**
   * Navigate to a URL, automatically handling PDF links.
   *
   * If the URL points to a PDF (by extension or Content-Type), downloads
   * and extracts text instead of navigating. Otherwise delegates to goto().
   *
   * @param {string} url
   * @param {object} [options]  All goto() options plus:
   * @param {boolean} [options.mergePages=true]  For PDFs: merge pages into one string.
   * @param {string}  [options.savePdfTo]        For PDFs: save binary to this path.
   * @returns {Promise<{isPdf: boolean, response?: import('playwright').Response|null, text?: string|string[], totalPages?: number, savedTo?: string}>}
   */
  async gotoOrPdf(url, options = {}) {
    this._ensurePage();

    const { mergePages, savePdfTo, ...gotoOptions } = options;

    if (isPdfUrl(url)) {
      const result = await this.getPdfText(url, { mergePages, saveTo: savePdfTo });
      return { isPdf: true, ...result };
    }

    try {
      const response = await this.goto(url, gotoOptions);
      return { isPdf: false, response };
    } catch (err) {
      if (err.message && err.message.includes('chrome-extension://')) {
        const currentUrl = this._page.url();
        const pdfMatch = currentUrl.match(/pdfurl=([^&]+)/);
        const pdfUrl = pdfMatch ? decodeURIComponent(pdfMatch[1]) : url;
        const result = await this.getPdfText(pdfUrl, { mergePages, saveTo: savePdfTo });
        return { isPdf: true, ...result };
      }
      throw err;
    }
  }

  // ---- Cleanup ----

  /**
   * Close the browser (persistent mode) or disconnect (CDP mode).
   * In CDP mode the Chrome process itself stays alive.
   */
  async close() {
    try {
      if (this._mode === 'persistent' && this._context) {
        await this._context.close();
      } else if (this._mode === 'cdp' && this._browser) {
        await this._browser.close();
      }
    } finally {
      this._browser = null;
      this._context = null;
      this._page = null;
      this._mode = null;
      this._childProcess = null;
    }
  }

  /**
   * Shut down Chrome launched by launchCDP().
   * Unlike close() (which just disconnects in CDP mode), this terminates Chrome.
   */
  async shutdown() {
    const child = this._childProcess;
    await this.close();
    if (child) {
      killProcess(child.pid);
    }
  }

  _killProcess() {
    if (!this._childProcess) return;
    const pid = this._childProcess.pid;
    this._childProcess = null;
    killProcess(pid);
  }

  // ---- Private helpers ----

  _ensureContext() {
    if (!this._context) {
      throw new Error('Browser not initialized. Call launch() or connectCDP() first.');
    }
  }

  _ensurePage() {
    this._ensureContext();
    if (!this._page) {
      throw new Error('No active page. Call newPage() or goto() first.');
    }
  }
}


// ============================================================
//  EXPORTS
// ============================================================

module.exports = BrowserUse;
module.exports.BrowserUse = BrowserUse;
module.exports.DEFAULT_PROFILE = DEFAULT_PROFILE;
module.exports.getDefaultUserDataDir = getDefaultUserDataDir;
module.exports.getCdpLaunchCommand = getCdpLaunchCommand;
module.exports.findChromeExecutable = findChromeExecutable;
module.exports.isPdfUrl = isPdfUrl;


// ============================================================
//  CLI
// ============================================================

if (require.main === module) {
  const HELP = `
Usage: node browserUse.js <url> [options]
       node browserUse.js --start [--profile <name>]
       node browserUse.js --shutdown

Actions:
  --start               Start Chrome with CDP (stays running in background)
  --shutdown            Shut down background Chrome on CDP port and exit

Options:
  --profile <name>      Chrome profile name (default: ${DEFAULT_PROFILE})
  --cdp [endpoint]      Connect via CDP (default: ${DEFAULT_CDP_ENDPOINT})
  --headless            Run headless
  --html [file]         Get page HTML (save to file or print to stdout)
  --screenshot [file]   Take screenshot (default: screenshot.png)
  --full-page           Full-page screenshot
  --images [dir]        Download content images (default: ./images)
  --extract [file]      Extract data via getDataFromText (save or print)
  --wait <selector>     Wait for selector before performing actions
  --timeout <ms>        Navigation timeout (default: 30000)
  --help                Show this help

CDP launch commands (run Chrome manually first):
  Windows:  ${getCdpLaunchCommand()}
  macOS:    ${getCdpLaunchCommand({ port: 9222, userDataDir: '$HOME/Library/Application Support/Google/Chrome/AgentProfile' })}
  Linux:    google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.config/google-chrome/AgentProfile"
`.trim();

  (async () => {
    const argv = process.argv.slice(2);

    if (argv.includes('--help') || argv.length === 0) {
      console.log(HELP);
      process.exit(0);
    }

    if (argv.includes('--shutdown')) {
      await BrowserUse.shutdown();
      console.error('Chrome shut down.');
      process.exit(0);
    }

    const flags = parseCliFlags(argv);

    if (flags.start) {
      const browser = new BrowserUse();
      await browser.launchCDP({ profile: flags.profile });
      const dir = getDefaultUserDataDir(flags.profile);
      console.error(`Chrome started with CDP on port ${DEFAULT_CDP_PORT}`);
      console.error(`Profile: ${dir}`);
      console.error(`Endpoint: ${DEFAULT_CDP_ENDPOINT}`);
      await browser.close();
      process.exit(0);
    }

    if (!flags.url) {
      console.error('Error: URL is required as the first positional argument.');
      process.exit(1);
    }

    const hasAction = flags.html || flags.screenshot || flags.images || flags.extract;
    if (!hasAction) {
      console.error('Error: specify at least one action: --html, --screenshot, --images, or --extract.');
      process.exit(1);
    }

    const browser = new BrowserUse();

    try {
      if (flags.cdp != null) {
        const endpointURL = typeof flags.cdp === 'string' ? flags.cdp : DEFAULT_CDP_ENDPOINT;
        await browser.connectCDP({ endpointURL, timeout: flags.timeout });
        console.error(`Connected via CDP to ${endpointURL}`);
      } else {
        await browser.launch({ headless: !!flags.headless, profile: flags.profile, timeout: flags.timeout });
        console.error(`Launched Chrome (persistent profile: ${getDefaultUserDataDir(flags.profile)})`);
      }

      await browser.goto(flags.url, { timeout: flags.timeout });
      console.error(`Navigated to ${flags.url}`);

      if (flags.wait) {
        await browser.waitFor(flags.wait, { state: 'visible', timeout: flags.timeout });
        console.error(`Element "${flags.wait}" appeared`);
      }

      if (flags.html) {
        const html = await browser.getHtml();
        if (typeof flags.html === 'string') {
          ensureDir(path.dirname(path.resolve(flags.html)));
          fs.writeFileSync(flags.html, html, 'utf-8');
          console.error(`HTML saved to ${flags.html} (${html.length} bytes)`);
        } else {
          process.stdout.write(html);
        }
      }

      if (flags.screenshot) {
        const file = typeof flags.screenshot === 'string' ? flags.screenshot : 'screenshot.png';
        await browser.screenshot({ path: file, fullPage: !!flags.fullPage });
        console.error(`Screenshot saved to ${file}`);
      }

      if (flags.images) {
        const outputDir = typeof flags.images === 'string' ? flags.images : './images';
        const results = await browser.downloadImages({ outputDir });
        const ok = results.filter(r => r.success);
        const fail = results.filter(r => !r.success);
        console.error(`Downloaded ${ok.length} images to ${outputDir}`);
        if (fail.length > 0) {
          console.error(`  Failed: ${fail.length}`);
          for (const f of fail) console.error(`    ${f.src}: ${f.error}`);
        }
      }

      if (flags.extract) {
        const html = await browser.getHtml();
        const getDataFromText = require('./getDataFromText');
        const result = getDataFromText(html);

        if (typeof flags.extract === 'string') {
          ensureDir(path.dirname(path.resolve(flags.extract)));
          fs.writeFileSync(flags.extract, JSON.stringify(result, null, 2), 'utf-8');
          console.error(`Extracted data saved to ${flags.extract}`);
          console.error(`  Navigation blocks: ${result.navigation.length}`);
          console.error(`  Content blocks:    ${result.content.length}`);
          console.error(`  Form blocks:       ${result.forms.length}`);
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
      }
    } finally {
      await browser.close();
    }
  })().catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}


// ============================================================
//  CLI ARG PARSING
// ============================================================

function parseCliFlags(argv) {
  const flags = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--cdp') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags.cdp = next; i++; }
      else flags.cdp = true;
    } else if (arg === '--start') {
      flags.start = true;
    } else if (arg === '--profile') {
      flags.profile = argv[++i];
    } else if (arg === '--headless') {
      flags.headless = true;
    } else if (arg === '--html') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags.html = next; i++; }
      else flags.html = true;
    } else if (arg === '--screenshot') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags.screenshot = next; i++; }
      else flags.screenshot = true;
    } else if (arg === '--full-page') {
      flags.fullPage = true;
    } else if (arg === '--images') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags.images = next; i++; }
      else flags.images = true;
    } else if (arg === '--extract') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags.extract = next; i++; }
      else flags.extract = true;
    } else if (arg === '--wait') {
      flags.wait = argv[++i];
    } else if (arg === '--timeout') {
      flags.timeout = parseInt(argv[++i], 10) || 30000;
    } else if (!arg.startsWith('--') && !flags.url) {
      flags.url = arg;
    }
  }

  if (!flags.timeout) flags.timeout = 30000;

  return flags;
}
