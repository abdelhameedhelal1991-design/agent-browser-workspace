'use strict';

const {
  joinMeta,
  renderOrderedItems,
  toAbsoluteUrl,
  truncate,
  uniqueBy,
} = require('./_controllerUtils');

function isCommentsPage(pageUrl) {
  try {
    const u = new URL(pageUrl);
    return /\/comments\//.test(u.pathname || '');
  } catch {
    return false;
  }
}

async function preparePage({ browser, pageUrl, profile }) {
  await browser.wait(2500);
  if (!isCommentsPage(pageUrl)) {
    const scroll = profile?.scraping?.reddit?.defaultScroll;
    if (scroll && Number(scroll.times) > 0) {
      await browser.scroll({
        times: Number(scroll.times),
        delay: Number(scroll.delay) || 1500,
        timeout: 45000,
      });
    }
    return;
  }

  const treeSelector = profile?.scraping?.selectors?.commentsTree;
  if (treeSelector) {
    try {
      await browser.scroll({ selector: treeSelector });
      await browser.wait(1500);
    } catch {
      // continue with best-effort comment extraction
    }
  }
}

async function getMarkdown({ browser, pageUrl }) {
  const state = await browser.evaluate((isPostPage) => {
    const text = (node) => node ? (node.textContent || '').replace(/\s+/g, ' ').trim() : '';
    const bodyText = (document.body && document.body.innerText) || '';
    const blocked = /log in|continue with email|use app|войти/i.test(bodyText)
      && !document.querySelector('shreddit-post');

    if (!isPostPage) {
      const posts = Array.from(document.querySelectorAll('shreddit-post')).map((post) => ({
        title: post.getAttribute('post-title') || '',
        href: post.getAttribute('permalink') || post.getAttribute('content-href') || '',
        score: post.getAttribute('score') || '',
        comments: post.getAttribute('comment-count') || '',
        flair: post.getAttribute('flair-text') || '',
      })).filter((item) => item.title);

      return {
        blocked,
        mode: 'listing',
        bodyPreview: bodyText.slice(0, 1800),
        posts,
      };
    }

    const post = document.querySelector('shreddit-post') || document.querySelector('[data-testid="post-container"]');
    const title = post ? (post.getAttribute('post-title') || text(post.querySelector('h1'))) : text(document.querySelector('h1'));
    const href = post ? (post.getAttribute('content-href') || post.getAttribute('permalink') || '') : '';
    const score = post ? (post.getAttribute('score') || '') : '';
    const commentsCount = post ? (post.getAttribute('comment-count') || '') : '';
    const flair = post ? (post.getAttribute('flair-text') || '') : '';
    const content = text(post);

    const comments = Array.from(document.querySelectorAll('shreddit-comment, [data-testid="comment"]'))
      .slice(0, 40)
      .map((comment) => ({
        text: text(comment),
        author: comment.getAttribute ? (comment.getAttribute('author') || '') : '',
        score: comment.getAttribute ? (comment.getAttribute('score') || '') : '',
      }))
      .filter((item) => item.text && item.text.length > 20);

    return {
      blocked,
      mode: 'discussion',
      title,
      href,
      score,
      commentsCount,
      flair,
      content,
      comments,
      bodyPreview: bodyText.slice(0, 1800),
    };
  }, isCommentsPage(pageUrl));

  const lines = [
    '## Reddit',
    '',
    `- **URL**: ${pageUrl}`,
  ];

  if (state.blocked) {
    lines.push('- **Статус**: Reddit показывает login/app wall или иной блокер.');
    lines.push('', '### Preview', '', '```text', truncate(state.bodyPreview, 1400), '```');
    return {
      mode: 'replace',
      markdown: lines.join('\n').trim(),
      data: {
        kind: 'blocked',
        preview: state.bodyPreview,
      },
      skipImageDownload: true,
    };
  }

  if (state.mode === 'discussion') {
    lines.push(`- **Заголовок**: ${state.title || 'Без заголовка'}`);
    if (state.href) lines.push(`- **Контент**: ${toAbsoluteUrl(pageUrl, state.href)}`);

    const meta = joinMeta([
      state.score ? `${state.score} pts` : '',
      state.commentsCount ? `${state.commentsCount} comments` : '',
      state.flair ? `[${state.flair}]` : '',
    ]);
    if (meta) lines.push(`- **Метаданные**: ${meta}`);

    if (state.content) {
      lines.push('', '### Пост', '', truncate(state.content, 1200));
    }

    lines.push('', '### Комментарии', '');
    lines.push(...renderOrderedItems(state.comments.slice(0, 15).map((item) => ({
      title: truncate(item.text, 320),
      meta: joinMeta([item.author, item.score ? `score ${item.score}` : '']),
    })), { emptyText: 'Комментарии не найдены.' }));

    return {
      mode: 'replace',
      markdown: lines.join('\n').trim(),
      data: {
        kind: 'discussion',
        ...state,
      },
      skipImageDownload: true,
    };
  }

  const posts = uniqueBy(
    state.posts.map((post) => ({
      ...post,
      href: toAbsoluteUrl(pageUrl, post.href),
    })),
    post => post.href || post.title,
  ).slice(0, 60);

  lines.push(`- **Постов**: ${posts.length}`, '');
  lines.push(...renderOrderedItems(posts.map((post) => ({
    title: post.title,
    href: post.href,
    meta: joinMeta([
      post.score ? `${post.score} pts` : '',
      post.comments ? `${post.comments} comments` : '',
      post.flair ? `[${post.flair}]` : '',
    ]),
  }))));

  return {
    mode: 'replace',
    markdown: lines.join('\n').trim(),
    data: {
      kind: 'listing',
      items: posts,
    },
    skipImageDownload: true,
  };
}

module.exports = {
  skipImageDownload: true,
  preparePage,
  getMarkdown,
};
