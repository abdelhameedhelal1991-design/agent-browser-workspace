'use strict';

const fs = require('fs');
const path = require('path');
const getDataFromText = require('../utils/getDataFromText');
const { isPdfUrl } = require('../utils/browserUse');
const {
  initBrowser,
  parseBaseFlags,
  flagsToBrowserOptions,
  releaseBrowser,
  getResolvedSiteInfoForUrl,
  getSiteProfileForHost,
} = require('./_shared');

const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

const getContentYoutube = require('./getContentYoutube');

/**
 * Get Markdown content of the current (or navigated-to) page,
 * download images from content blocks, replace image URLs with local paths,
 * and save the resulting Markdown file.
 *
 * @param {object} options
 * @param {import('../utils/browserUse')} [options.browser]  Existing BrowserUse instance.
 * @param {string}  [options.html]          Pre-fetched HTML (skips browser.getHtml()).
 * @param {string}  [options.url]           URL to navigate to (null = current page).
 * @param {string}   options.dir            Output directory for the MD file.
 * @param {string}   options.name           Filename for the MD file.
 * @param {string}  [options.imageSubdir='images']  Subdirectory for images (relative to dir).
 * @param {number}  [options.minWidth=100]  Skip images narrower than this.
 * @param {number}  [options.minHeight=100] Skip images shorter than this.
 * @param {boolean} [options.downloadImages] If `html` is passed, controls whether images are still downloaded from DOM.
 * @param {boolean|string} [options.cdp]    CDP connection flag / endpoint.
 * @param {boolean} [options.launch]        Force launch mode.
 * @param {boolean} [options.headless]      Headless mode.
 * @param {number}  [options.timeout]       Timeout.
 * @returns {Promise<{markdown: string, images: Array, savedTo: string, metadata: object, site?: object|null, youtube?: object|null}>}
 */
async function getContent(options = {}) {
  const {
    url,
    html: preloadedHtml,
    dir,
    name,
    imageSubdir = 'images',
    minWidth = 100,
    minHeight = 100,
    downloadImages: downloadImagesOption,
    ...browserOptions
  } = options;

  if (!dir || !name) {
    throw new Error('Both "dir" and "name" options are required.');
  }

  const downloadImages = downloadImagesOption ?? !preloadedHtml;

  const absDir = path.resolve(dir);
  const absImageDir = path.resolve(absDir, imageSubdir);
  const absFilePath = path.join(absDir, name);

  const { browser, ownsInstance } = await initBrowser(browserOptions);

  try {
    // PDF: download and extract text instead of navigating
    const targetUrl = url || (browser.page ? browser.getUrl() : '');
    if (targetUrl && isPdfUrl(targetUrl)) {
      const pdfResult = await browser.getPdfText(targetUrl, { mergePages: true });
      const markdown = pdfResult.text || '';

      ensureDir(absDir);
      fs.writeFileSync(absFilePath, markdown, 'utf-8');

      return {
        markdown,
        images: [],
        savedTo: absFilePath,
        metadata: { title: path.basename(targetUrl), isPdf: true, totalPages: pdfResult.totalPages },
        site: getResolvedSiteInfoForUrl(targetUrl),
      };
    }

    if (url) {
      await browser.goto(url, { timeout: browserOptions.timeout });
      try {
        await browser.waitForLoadState('networkidle', { timeout: 5000 });
      } catch { /* proceed if network doesn't idle */ }
    }

    // Detect PDF redirect from chrome extension (Adobe Acrobat, etc.)
    const currentUrl = browser.page ? browser.getUrl() : '';
    if (currentUrl.includes('chrome-extension://') && currentUrl.includes('pdfurl=')) {
      const pdfMatch = currentUrl.match(/pdfurl=([^&]+)/);
      const pdfUrl = pdfMatch ? decodeURIComponent(pdfMatch[1]) : url;
      if (pdfUrl) {
        const pdfResult = await browser.getPdfText(pdfUrl, { mergePages: true });
        const markdown = pdfResult.text || '';

        ensureDir(absDir);
        fs.writeFileSync(absFilePath, markdown, 'utf-8');

        return {
          markdown,
          images: [],
          savedTo: absFilePath,
          metadata: { title: path.basename(pdfUrl), isPdf: true, totalPages: pdfResult.totalPages },
          site: getResolvedSiteInfoForUrl(pdfUrl),
        };
      }
    }

    const html = preloadedHtml || await browser.getHtml();
    const pageUrl = browser.page ? browser.getUrl() : '';

    const data = getDataFromText(html);

    const contentSelectors = data.content
      .map(b => b.cssSelector)
      .filter(Boolean);

    const imgSelector = contentSelectors.length > 0
      ? contentSelectors.map(s => `${s} img`).join(', ')
      : 'img';

    let images = [];
    if (downloadImages && browser.page) {
      images = await browser.downloadImages({
        outputDir: absImageDir,
        selector: imgSelector,
        minWidth,
        minHeight,
      });
    }

    const urlToLocal = buildImageMapping(images, absDir);

    const markdownParts = data.content.map(block => {
      if (!block.markdown) return '';
      return replaceImageUrls(block.markdown, urlToLocal, pageUrl);
    });

    let markdown = markdownParts.filter(Boolean).join('\n\n');

    let youtube = null;
    const siteProfile = (() => {
      try {
        const host = pageUrl ? new URL(pageUrl).hostname : '';
        return host ? getSiteProfileForHost(host) : null;
      } catch {
        return null;
      }
    })();

    if (siteProfile && siteProfile.id === 'youtube' && browser.page) {
      const enrichment = await getContentYoutube({
        browser,
        pageUrl,
        profile: siteProfile,
        timeoutMs: browserOptions.timeout,
      });
      if (enrichment) {
        youtube = enrichment.youtube || null;
        if (enrichment.markdown) {
          markdown = enrichment.markdown + (markdown ? `\n\n---\n\n${markdown}` : '');
        }
      }
    }

    ensureDir(absDir);
    fs.writeFileSync(absFilePath, markdown, 'utf-8');

    return {
      markdown,
      images,
      savedTo: absFilePath,
      metadata: data.metadata,
      site: getResolvedSiteInfoForUrl(pageUrl),
      ...(youtube ? { youtube } : {}),
    };
  } finally {
    await releaseBrowser(browser, ownsInstance);
  }
}

/**
 * Build a mapping from original image URL → relative local path.
 * @param {Array} images        Results from browser.downloadImages().
 * @param {string} baseDir      Directory the MD file lives in (for relative paths).
 * @returns {Map<string, string>}
 */
function buildImageMapping(images, baseDir) {
  const map = new Map();
  for (const img of images) {
    if (!img.success || !img.savedAs) continue;
    const rel = path.relative(baseDir, img.savedAs).replace(/\\/g, '/');
    map.set(img.src, rel);
  }
  return map;
}

/**
 * Replace image URLs in Markdown text with local relative paths.
 * @param {string} markdown
 * @param {Map<string, string>} urlToLocal
 * @param {string} pageUrl        Base URL for resolving relative src attributes.
 * @returns {string}
 */
function replaceImageUrls(markdown, urlToLocal, pageUrl) {
  if (urlToLocal.size === 0) return markdown;

  return markdown.replace(MD_IMAGE_RE, (match, alt, rawUrl) => {
    const localPath = urlToLocal.get(rawUrl);
    if (localPath) return `![${alt}](${localPath})`;

    let absoluteUrl;
    try { absoluteUrl = new URL(rawUrl, pageUrl).href; } catch { return match; }
    const localAbs = urlToLocal.get(absoluteUrl);
    if (localAbs) return `![${alt}](${localAbs})`;

    for (const [src, local] of urlToLocal) {
      try {
        if (new URL(src, pageUrl).href === absoluteUrl) return `![${alt}](${local})`;
      } catch { /* skip */ }
    }

    return match;
  });
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}


// ============================================================
//  EXPORTS
// ============================================================

module.exports = getContent;


// ============================================================
//  CLI
// ============================================================

if (require.main === module) {
  const HELP = `
Usage: node scripts/getContent.js --dir <dir> --name <file> [options]

Options:
  --dir <dir>             Output directory for the Markdown file (required)
  --name <file>           Filename for the Markdown file (required)
  --url <url>             Navigate to URL before extracting (default: current page)
  --image-subdir <dir>    Subdirectory for images relative to --dir (default: images)
  --min-width <px>        Skip images narrower than this (default: 100)
  --min-height <px>       Skip images shorter than this (default: 100)
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
    const extra = parseContentFlags(argv);

    if (!extra.dir || !extra.name) {
      console.error('Error: --dir and --name are required.');
      process.exit(1);
    }

    const result = await getContent({
      ...flagsToBrowserOptions(flags),
      url: flags.url,
      dir: extra.dir,
      name: extra.name,
      imageSubdir: extra.imageSubdir,
      minWidth: extra.minWidth,
      minHeight: extra.minHeight,
    });

    const okImages = result.images.filter(r => r.success).length;
    const failImages = result.images.filter(r => !r.success).length;

    console.error(`Title: ${result.metadata.title || '(no title)'}`);
    console.error(`Content saved to: ${result.savedTo}`);
    console.error(`Markdown length: ${result.markdown.length} chars`);
    console.error(`Images downloaded: ${okImages}, failed: ${failImages}`);
  })().catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}

function parseContentFlags(argv) {
  const flags = {
    dir: null,
    name: null,
    imageSubdir: 'images',
    minWidth: 100,
    minHeight: 100,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir') flags.dir = argv[++i];
    else if (arg === '--name') flags.name = argv[++i];
    else if (arg === '--image-subdir') flags.imageSubdir = argv[++i];
    else if (arg === '--min-width') flags.minWidth = parseInt(argv[++i], 10) || 100;
    else if (arg === '--min-height') flags.minHeight = parseInt(argv[++i], 10) || 100;
  }

  return flags;
}
