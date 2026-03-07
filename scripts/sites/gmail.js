'use strict';

const {
  renderOrderedItems,
  sanitizeMarkdown,
  truncate,
  uniqueBy,
} = require('./_controllerUtils');

function isMessageUrl(pageUrl) {
  try {
    const hash = new URL(pageUrl).hash || '';
    return /#(?:all|inbox|label|category)\/[A-Za-z0-9]+/i.test(hash);
  } catch {
    return false;
  }
}

async function preparePage({ browser }) {
  await browser.wait(3500);
}

async function getMarkdown({ browser, pageUrl, profile }) {
  const keywords = Array.isArray(profile?.scraping?.gmail?.newsletterKeywords)
    ? profile.scraping.gmail.newsletterKeywords
    : [];

  const isMessage = isMessageUrl(pageUrl);

  if (isMessage) {
    const message = await browser.evaluate(() => {
      const text = (node) => node ? (node.textContent || '').replace(/\s+/g, ' ').trim() : '';
      const subject = text(document.querySelector('h2.hP'));
      const bodyParts = Array.from(document.querySelectorAll('.a3s.aiL, .ii.gt div, .a3s'))
        .map((node) => text(node))
        .filter(Boolean);
      const bodyText = bodyParts.join('\n\n');
      const links = Array.from(document.querySelectorAll('.a3s.aiL a[href], .ii.gt div a[href], .a3s a[href]'))
        .map((a) => ({
          text: text(a),
          href: a.href || '',
        }))
        .filter((item) => item.href && item.text);

      return {
        subject,
        bodyText,
        links,
      };
    });

    const uniqueLinks = uniqueBy(message.links, item => item.href).slice(0, 40);
    const lines = [
      '## Gmail Message',
      '',
      `- **URL**: ${pageUrl}`,
    ];

    if (message.subject) lines.push(`- **Тема**: ${message.subject}`);
    lines.push(`- **Ссылок**: ${uniqueLinks.length}`, '');

    if (message.bodyText) {
      lines.push('### Содержимое', '', sanitizeMarkdown(truncate(message.bodyText, 4000)));
    }

    if (uniqueLinks.length > 0) {
      lines.push('', '### Ссылки', '');
      lines.push(...renderOrderedItems(uniqueLinks.map((item) => ({
        title: item.text,
        href: item.href,
      }))));
    }

    return {
      mode: 'replace',
      markdown: lines.join('\n').trim(),
      data: {
        kind: 'message',
        subject: message.subject,
        bodyText: message.bodyText,
        links: uniqueLinks,
      },
      skipImageDownload: true,
    };
  }

  const inbox = await browser.evaluate((senderKeywords) => {
    const text = (node) => node ? (node.textContent || '').replace(/\s+/g, ' ').trim() : '';
    const title = document.title || '';
    const rows = Array.from(document.querySelectorAll('tr.zA')).slice(0, 100);
    const items = rows.map((row) => {
      const sender = text(row.querySelector('.yW .zF, .yW .yP'));
      const subject = text(row.querySelector('.bog, .bqe'));
      const snippet = text(row.querySelector('.y2'));
      const isUnread = row.classList.contains('zE');
      const matchesKeyword = senderKeywords.some((keyword) => {
        const k = String(keyword || '').toLowerCase();
        return sender.toLowerCase().includes(k) || subject.toLowerCase().includes(k);
      });
      return {
        sender,
        subject,
        snippet,
        isUnread,
        matchesKeyword,
      };
    }).filter((item) => item.sender || item.subject);

    return {
      title,
      items,
      bodyPreview: ((document.body && document.body.innerText) || '').slice(0, 2000),
    };
  }, keywords);

  const looksLoggedOut = /sign in|войти/i.test(inbox.title) || inbox.items.length === 0 && /welcome to gmail|choose an account/i.test(inbox.bodyPreview);
  const newsletters = inbox.items.filter((item) => item.matchesKeyword).slice(0, 30);

  const lines = [
    '## Gmail Inbox',
    '',
    `- **URL**: ${pageUrl}`,
  ];

  if (looksLoggedOut) {
    lines.push('- **Статус**: Похоже, Gmail не залогинен или недоступен.');
    lines.push('', '### Preview', '', '```text', truncate(inbox.bodyPreview, 1500), '```');
    return {
      mode: 'replace',
      markdown: lines.join('\n').trim(),
      data: {
        kind: 'login-required',
        preview: inbox.bodyPreview,
      },
      skipImageDownload: true,
    };
  }

  lines.push(`- **Всего писем в выборке**: ${inbox.items.length}`);
  lines.push(`- **Найдено рассылок**: ${newsletters.length}`, '');
  lines.push(...renderOrderedItems(newsletters.map((item) => ({
    title: `${item.sender}: ${item.subject}`,
    meta: item.isUnread ? 'непрочитано' : '',
    desc: item.snippet ? truncate(item.snippet, 220) : '',
  })), { emptyText: 'Подходящие рассылки не найдены.' }));

  return {
    mode: 'replace',
    markdown: lines.join('\n').trim(),
    data: {
      kind: 'inbox',
      items: newsletters,
      totalItems: inbox.items.length,
    },
    skipImageDownload: true,
  };
}

module.exports = {
  skipImageDownload: true,
  preparePage,
  getMarkdown,
};
