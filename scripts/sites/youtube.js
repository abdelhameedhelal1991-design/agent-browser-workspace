'use strict';

const getContentYoutube = require('../getContentYoutube');

async function getMarkdown({ browser, pageUrl, profile, timeoutMs }) {
  const enrichment = await getContentYoutube({
    browser,
    pageUrl,
    profile,
    timeoutMs,
  });

  if (!enrichment) return null;

  return {
    mode: 'prepend',
    markdown: enrichment.markdown || '',
    extra: enrichment.youtube ? { youtube: enrichment.youtube } : {},
  };
}

module.exports = {
  getMarkdown,
};
