'use strict';

const {
  joinMeta,
  renderOrderedItems,
  toAbsoluteUrl,
  truncate,
  uniqueBy,
} = require('./_controllerUtils');

async function preparePage({ browser, profile }) {
  await browser.wait(4000);
  const scroll = profile?.scraping?.xTwitter?.defaultScroll;
  if (scroll && Number(scroll.times) > 0) {
    await browser.scroll({
      times: Number(scroll.times),
      delay: Number(scroll.delay) || 2000,
      timeout: 45000,
    });
  }
}

async function getMarkdown({ browser, pageUrl }) {
  const state = await browser.evaluate(() => {
    const text = (node) => node ? (node.textContent || '').replace(/\s+/g, ' ').trim() : '';
    const bodyText = (document.body && document.body.innerText) || '';
    const loginRequired = /sign in|log in|войти|зарегистрируйтесь/i.test(bodyText) && document.querySelector('input[name="text"], [data-testid="loginButton"]');

    const tweets = Array.from(document.querySelectorAll('article')).map((article) => {
      const textEl = article.querySelector('[data-testid="tweetText"]');
      const timeEl = article.querySelector('time');
      const statusLink = article.querySelector('a[href*="/status/"]');
      const externalLinks = Array.from(article.querySelectorAll('a[href]'))
        .map((a) => a.href || '')
        .filter((href) => href && !/x\.com|twitter\.com/.test(href));

      return {
        text: text(textEl),
        datetime: timeEl ? timeEl.getAttribute('datetime') || '' : '',
        href: statusLink ? statusLink.href : '',
        externalLinks: Array.from(new Set(externalLinks)).slice(0, 5),
      };
    }).filter((tweet) => tweet.text);

    return {
      loginRequired: !!loginRequired,
      bodyPreview: bodyText.slice(0, 2000),
      tweets,
    };
  });

  const lines = [
    '## X / Twitter',
    '',
    `- **URL**: ${pageUrl}`,
  ];

  if (state.loginRequired) {
    lines.push('- **Статус**: Похоже, X требует входа в аккаунт или показывает login wall.');
    lines.push('', '### Preview', '', '```text', truncate(state.bodyPreview, 1500), '```');
    return {
      mode: 'replace',
      markdown: lines.join('\n').trim(),
      data: {
        kind: 'login-required',
        preview: state.bodyPreview,
      },
      skipImageDownload: true,
    };
  }

  const tweets = uniqueBy(
    state.tweets.map((tweet) => ({
      ...tweet,
      href: toAbsoluteUrl(pageUrl, tweet.href),
    })),
    tweet => tweet.href || tweet.text,
  ).slice(0, 30);

  lines.push(`- **Постов**: ${tweets.length}`, '');
  lines.push(...renderOrderedItems(tweets.map((tweet) => ({
    title: truncate(tweet.text, 220),
    href: tweet.href,
    meta: joinMeta([tweet.datetime ? tweet.datetime.slice(0, 19) : '']),
    desc: tweet.externalLinks.length > 0 ? `Внешние ссылки: ${tweet.externalLinks.join(', ')}` : '',
  }))));

  return {
    mode: 'replace',
    markdown: lines.join('\n').trim(),
    data: {
      kind: 'timeline',
      items: tweets,
    },
    skipImageDownload: true,
  };
}

module.exports = {
  skipImageDownload: true,
  preparePage,
  getMarkdown,
};
