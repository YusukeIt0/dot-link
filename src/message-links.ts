export interface MessagePart { text: string; href?: string; }

/** Only explicit web addresses become links; conversation text is never HTML. */
export function messageParts(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  const pattern = /\b(?:https?:\/\/|www\.)(?:\[[0-9a-f:.]+\]|[^\s\[\]<>"'`\u3000\u3001\u3002\uff01\uff1f\uff09\u300d\u300f])+/giu;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    let address = match[0].replace(/[.,;:!?]+$/u, '');
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      while (address.endsWith(close) && address.split(close).length > address.split(open).length) address = address.slice(0, -1);
    }
    let url: URL;
    try { url = new URL(/^www\./i.test(address) ? `https://${address}` : address); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) continue;
    if (match.index > offset) parts.push({ text: text.slice(offset, match.index) });
    parts.push({ text: address, href: url.href });
    offset = match.index + address.length;
  }
  if (offset < text.length) parts.push({ text: text.slice(offset) });
  return parts;
}

/** Keep a Markdown link's human label, but omit its destination on G2 and in speech. */
export function withoutMessageUrls(text: string): string {
  const parts = messageParts(text);
  for (let index = 0; index < parts.length; index++) {
    if (!parts[index].href) continue;
    const before = parts[index - 1], after = parts[index + 1];
    if (before && after && /\[[^\]\n]*\]\(\s*$/.test(before.text) && /^\s*(?:"[^"\n]*"\s*)?\)/.test(after.text)) {
      before.text = before.text.replace(/\[([^\]\n]*)\]\(\s*$/, '$1');
      after.text = after.text.replace(/^\s*(?:"[^"\n]*"\s*)?\)/, '');
    } else if (before?.text.endsWith('<') && after?.text.startsWith('>')) {
      before.text = before.text.slice(0, -1); after.text = after.text.slice(1);
    }
  }
  return parts.filter(part => !part.href).map(part => part.text).join('')
    .replace(/\[\]\(\s*\)/g, '')
    .replace(/[\t ]+\n/g, '\n').replace(/[\t ]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export function renderMessageLinks(container: HTMLElement, text: string): void {
  const document = container.ownerDocument;
  const nodes = messageParts(text).map(part => {
    if (!part.href) return document.createTextNode(part.text);
    const link = document.createElement('a');
    link.textContent = part.text;
    link.href = part.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  });
  container.replaceChildren(...nodes);
}
