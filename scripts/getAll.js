'use strict';

const fs = require('fs');
const path = require('path');
const getContent = require('./getContent');
const getForms = require('./getForms');
const { initBrowser, parseBaseFlags, flagsToBrowserOptions, releaseBrowser, getResolvedSiteInfoForUrl } = require('./_shared');

/**
 * Get both Markdown content (with images) and forms from the current
 * (or navigated-to) page in a single browser session.
 *
 * HTML is fetched once and shared between getContent and getForms
 * to avoid redundant requests.
 *
 * @param {object} options
 * @param {import('../utils/browserUse')} [options.browser]  Existing BrowserUse instance.
 * @param {string}  [options.url]              URL to navigate to (null = current page).
 * @param {string}   options.dir               Output directory for the MD file.
 * @param {string}   options.name              Filename for the MD file.
 * @param {string}  [options.imageSubdir='images']  Subdirectory for images.
 * @param {number}  [options.minWidth=100]     Skip narrow images.
 * @param {number}  [options.minHeight=100]    Skip short images.
 * @param {string}  [options.formsOutput]      Optional path to save forms JSON.
 * @param {boolean|string} [options.cdp]       CDP connection flag / endpoint.
 * @param {boolean} [options.launch]           Force launch mode.
 * @param {boolean} [options.headless]         Headless mode.
 * @param {number}  [options.timeout]          Timeout.
 * @returns {Promise<{markdown: string, images: Array, savedTo: string, forms: Array, metadata: object, site?: object|null}>}
 */
async function getAll(options = {}) {
  const {
    url,
    dir,
    name,
    imageSubdir = 'images',
    minWidth = 100,
    minHeight = 100,
    formsOutput,
    ...browserOptions
  } = options;

  if (!dir || !name) {
    throw new Error('Both "dir" and "name" options are required.');
  }

  const { browser, ownsInstance } = await initBrowser(browserOptions);

  try {
    if (url) {
      await browser.goto(url, { timeout: browserOptions.timeout });
      try {
        await browser.waitForLoadState('networkidle', { timeout: 5000 });
      } catch { /* proceed if network doesn't idle */ }
    }

    const html = await browser.getHtml();

    // IMPORTANT: do not access a shared browser instance concurrently.
    // Keep all browser operations strictly sequential.
    const contentResult = await getContent({
      browser,
      html,
      dir,
      name,
      imageSubdir,
      minWidth,
      minHeight,
      downloadImages: true,
    });

    const formsResult = await getForms({
      browser,
      html,
    });

    const pageUrl = browser.page ? browser.getUrl() : '';

    const metadata = {
      ...contentResult.metadata,
      url: pageUrl,
    };
    const site = getResolvedSiteInfoForUrl(pageUrl);

    if (formsOutput) {
      const absPath = path.resolve(formsOutput);
      const outDir = path.dirname(absPath);
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(absPath, JSON.stringify({ forms: formsResult.forms, metadata, site }, null, 2), 'utf-8');
    }

    return {
      markdown: contentResult.markdown,
      images: contentResult.images,
      savedTo: contentResult.savedTo,
      forms: formsResult.forms,
      metadata,
      site,
    };
  } finally {
    await releaseBrowser(browser, ownsInstance);
  }
}


// ============================================================
//  EXPORTS
// ============================================================

module.exports = getAll;


// ============================================================
//  CLI
// ============================================================

if (require.main === module) {
  const HELP = `
Usage: node scripts/getAll.js --dir <dir> --name <file> [options]

Options:
  --dir <dir>             Output directory for the Markdown file (required)
  --name <file>           Filename for the Markdown file (required)
  --url <url>             Navigate to URL before extracting (default: current page)
  --image-subdir <dir>    Subdirectory for images relative to --dir (default: images)
  --min-width <px>        Skip images narrower than this (default: 100)
  --min-height <px>       Skip images shorter than this (default: 100)
  --forms-output <file>   Save forms to a separate JSON file
  --profile <name>        Chrome profile name (default: AgentProfile)
  --cdp [endpoint]        Connect via CDP (default: http://localhost:9222)
  --launch                Force launch a new browser
  --headless              Run headless
  --timeout <ms>          Timeout (default: 30000)
  --help                  Show this help
`.trim();

  (async () => {
    const argv = process.argv.slice(2);

    if (argv.includes('--help') || argv.length === 0) {
      console.log(HELP);
      process.exit(0);
    }

    const flags = parseBaseFlags(argv);
    const extra = parseAllFlags(argv);

    if (!extra.dir || !extra.name) {
      console.error('Error: --dir and --name are required.');
      process.exit(1);
    }

    const result = await getAll({
      ...flagsToBrowserOptions(flags),
      url: flags.url,
      dir: extra.dir,
      name: extra.name,
      imageSubdir: extra.imageSubdir,
      minWidth: extra.minWidth,
      minHeight: extra.minHeight,
      formsOutput: extra.formsOutput,
    });

    const okImages = result.images.filter(r => r.success).length;
    const failImages = result.images.filter(r => !r.success).length;

    console.error(`Title: ${result.metadata.title || '(no title)'}`);
    console.error(`Content saved to: ${result.savedTo}`);
    console.error(`Markdown length: ${result.markdown.length} chars`);
    console.error(`Images downloaded: ${okImages}, failed: ${failImages}`);
    console.error(`Forms found: ${result.forms.length}`);
    for (const f of result.forms) {
      console.error(`  [${f.type}] ${f.selector} (${f.fields.length} fields)`);
    }
    if (extra.formsOutput) {
      console.error(`Forms JSON saved to: ${extra.formsOutput}`);
    }
  })().catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}

function parseAllFlags(argv) {
  const flags = {
    dir: null,
    name: null,
    imageSubdir: 'images',
    minWidth: 100,
    minHeight: 100,
    formsOutput: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir') flags.dir = argv[++i];
    else if (arg === '--name') flags.name = argv[++i];
    else if (arg === '--image-subdir') flags.imageSubdir = argv[++i];
    else if (arg === '--min-width') flags.minWidth = parseInt(argv[++i], 10) || 100;
    else if (arg === '--min-height') flags.minHeight = parseInt(argv[++i], 10) || 100;
    else if (arg === '--forms-output') flags.formsOutput = argv[++i];
  }

  return flags;
}
