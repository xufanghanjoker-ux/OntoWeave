import {Lexer} from 'marked';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
// Entities remain text in an HTML text node; they cannot introduce tags or attributes.
// Reading token.raw also keeps entity-encoded brackets from becoming citation syntax.
const escapeMarkdownText = value => escapeHtml(value).replace(/&amp;((?:#[0-9]{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});)/gi, '&$1');
const positiveNumber = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const protectedTypes = new Set(['code', 'codespan', 'link', 'image']);
function citationState(token) {
  // Complete definitions are already `def` AST nodes. Unfinished definitions
  // at the start of a paragraph also stay inert while streaming.
  const prefix = ['paragraph', 'text'].includes(token?.type) && Array.isArray(token.tokens)
    ? /^[ \t]{0,3}\[[1-9][0-9]*\]:[ \t]*([\s\S]*)$/.exec(token.raw ?? '') : null;
  const rest = prefix?.[1].trimEnd(), title = rest && /^(?:<[^>\r\n]*>|[^\s]+)[ \t]+(["'(])([\s\S]*)$/.exec(rest);
  const pending = prefix && (rest === '' || /^<[^>\r\n]*$/.test(rest) || title && !title[2].includes(title[1] === '(' ? ')' : title[1]));
  return {pendingTicks: 0, pendingDefinition: Boolean(pending)};
}
function hasProtectedSyntax(value) {
  if (Array.isArray(value)) return value.some(hasProtectedSyntax);
  if (!value || typeof value !== 'object') return false;
  return protectedTypes.has(value.type) || ['tokens', 'items', 'header', 'rows'].some(key => hasProtectedSyntax(value[key]));
}

function registeredNumbers(registry) {
  const entries = Array.isArray(registry) ? registry : registry instanceof Map ? [...registry.values()] : [];
  const numbers = new Map(), conflicts = new Set();
  for (const entry of entries) {
    if (!entry || !positiveNumber(entry.number) || typeof entry.citation_ref !== 'string' || !entry.citation_ref.trim()) continue;
    const previous = numbers.get(entry.number);
    if (previous !== undefined && previous !== entry.citation_ref) conflicts.add(entry.number);
    numbers.set(entry.number, entry.citation_ref);
  }
  for (const number of conflicts) numbers.delete(number);
  return numbers;
}

function safeLink(href) {
  if (typeof href !== 'string' || /[\u0000-\u0020\u007f]/u.test(href)) return null;
  // No relative/protocol-relative, javascript, data, file, or blob destinations.
  // Keep URL parsing independent of the page's base URI.
  if (!/^(?:https?:\/\/|mailto:)/i.test(href)) return null;
  try {
    const url = new URL(href);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.hostname ? href : null;
    if (url.protocol === 'mailto:' && href.slice(7) && !/[<>]/.test(href)) return href;
  } catch {}
  return null;
}

/**
 * Safe, synchronous Markdown projection for a whole accumulated turn body.
 * registry is [{number, citation_ref, citation?}] (or a Map of those entries).
 * Numbers are looked up, never allocated or reordered; result arrays follow first
 * body occurrence. Re-render accumulated Markdown on a delta, without animation.
 * Only fixed tags/attributes are emitted. Marked's HTML renderer is never used.
 */
export function renderLightogChatMarkdown(markdown, {registry = [], turnId = ''} = {}) {
  const source = typeof markdown === 'string' ? markdown : '';
  const registered = registeredNumbers(registry), used = new Set(), unknown = new Set();
  const turn = escapeHtml(typeof turnId === 'string' ? turnId : '');

  function citation(number) {
    if (registered.has(number)) {
      used.add(number);
      return `<sup class="lw-chat-citation-ref"><button type="button" class="lw-chat-citation" data-chat-action="citation" data-turn="${turn}" data-number="${number}" aria-label="查看来源 ${number}">[${number}]</button></sup>`;
    }
    unknown.add(number);
    return `<span class="lw-chat-citation-unknown" title="来源编号未登记" aria-label="来源 ${number} 未登记">[${number}]⚠</span>`;
  }

  function text(raw, allowCitations, inlineState) {
    if (!allowCitations) return escapeMarkdownText(raw);
    let html = '', cursor = 0;
    // Balanced code is already a codespan token. Remaining backtick runs are
    // unfinished inline code: conservatively leave its following refs inert
    // until a later accumulated render can lex a complete codespan.
    const pattern = /`+|\[([1-9][0-9]*)\]/g;
    for (const match of raw.matchAll(pattern)) {
      const at = match.index;
      html += escapeMarkdownText(raw.slice(cursor, at));
      if (match[0][0] === '`') {
        const length = match[0].length;
        if (!inlineState.pendingTicks) inlineState.pendingTicks = length;
        else if (inlineState.pendingTicks === length) inlineState.pendingTicks = 0;
        html += escapeMarkdownText(match[0]);
      } else {
        const number = Number(match[1]);
        const before = raw[at - 1], after = raw[at + match[0].length];
        const nextIsCitation = /^\[[1-9][0-9]*\]/.test(raw.slice(at + match[0].length));
        // A half-received link/image/reference link stays literal while streaming.
        const incompleteLink = before === '!' || before === '[' || after === '(' || (after === '[' && !nextIsCitation) || after === ']' || inlineState.pendingDefinition;
        html += !inlineState.pendingTicks && !incompleteLink && positiveNumber(number) ? citation(number) : escapeMarkdownText(match[0]);
      }
      cursor = at + match[0].length;
    }
    return html + escapeMarkdownText(raw.slice(cursor));
  }

  function inline(tokens, allowCitations = true, depth = 0, state = {pendingTicks: 0, pendingDefinition: null}) {
    return (tokens || []).map(token => render(token, allowCitations, depth + 1, state)).join('');
  }

  function blocks(tokens, depth = 0, tight = false) {
    return (tokens || []).map(token => {
      if (tight && token.type === 'paragraph') return inline(token.tokens, true, depth + 1, citationState(token));
      return render(token, true, depth + 1, citationState(token));
    }).join('');
  }

  function render(token, allowCitations, depth, state) {
    if (depth > 128) return escapeHtml(token.raw ?? token.text ?? '');
    const contents = () => inline(token.tokens, allowCitations, depth, state);
    switch (token.type) {
      case 'space': return '';
      case 'def': return ''; // Markdown link definitions are not body citations.
      case 'text': return token.tokens ? contents() : text(String(token.raw ?? token.text ?? ''), allowCitations, state);
      case 'escape': return escapeHtml(token.text);
      case 'paragraph': return `<p>${inline(token.tokens, allowCitations, depth, citationState(token))}</p>\n`;
      case 'heading': {
        const level = Number.isInteger(token.depth) && token.depth >= 1 && token.depth <= 6 ? token.depth : 2;
        return `<h${level}>${contents()}</h${level}>\n`;
      }
      case 'strong': return `<strong>${contents()}</strong>`;
      case 'em': return `<em>${contents()}</em>`;
      case 'del': return `<del>${contents()}</del>`;
      case 'br': return '<br>\n';
      case 'hr': return '<hr>\n';
      case 'codespan': return `<code>${escapeHtml(token.text)}</code>`;
      case 'code': return `<pre><code>${escapeHtml(token.text)}</code></pre>\n`;
      case 'html': return escapeHtml(token.raw ?? token.text ?? '');
      case 'blockquote': return `<blockquote>\n${blocks(token.tokens, depth)}</blockquote>\n`;
      case 'list': {
        const tag = token.ordered ? 'ol' : 'ul';
        const start = token.ordered && positiveNumber(token.start) && token.start !== 1 ? ` start="${token.start}"` : '';
        const items = (token.items || []).map(item => `<li>${blocks(item.tokens, depth, !item.loose)}</li>\n`).join('');
        return `<${tag}${start}>\n${items}</${tag}>\n`;
      }
      case 'list_item': return `<li>${blocks(token.tokens, depth, !token.loose)}</li>\n`;
      case 'checkbox': return `<span class="lw-chat-task" aria-label="${token.checked ? '已完成' : '未完成'}">${token.checked ? '☑' : '☐'}</span> `;
      case 'table': {
        const row = (cells, heading) => `<tr>${(cells || []).map(cell => {
          const tag = heading ? 'th' : 'td', align = ['left', 'center', 'right'].includes(cell.align) ? ` class="lw-chat-align-${cell.align}"` : '';
          return `<${tag}${align}>${inline(cell.tokens, allowCitations, depth)}</${tag}>`;
        }).join('')}</tr>\n`;
        return `<table>\n<thead>${row(token.header, true)}</thead>\n<tbody>${(token.rows || []).map(cells => row(cells, false)).join('')}</tbody>\n</table>\n`;
      }
      case 'link': {
        const label = inline(token.tokens, false, depth), href = safeLink(token.href);
        return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : `<span class="lw-chat-link-inert">${label}</span>`;
      }
      case 'image': return `<span class="lw-chat-image-alt">${inline(token.tokens, false, depth) || escapeHtml(token.text || '图片')}</span>`;
      default: return escapeHtml(token.raw ?? token.text ?? '');
    }
  }

  let html, protectedSyntax = false;
  try {
    const tokens = Lexer.lex(source, {gfm: true, breaks: false});
    protectedSyntax = hasProtectedSyntax(tokens);
    html = blocks(tokens);
  }
  catch {
    // A malformed/too-deep streaming prefix is still readable, with no actions.
    used.clear(); unknown.clear();
    html = `<pre class="lw-chat-markdown-plain">${escapeHtml(source)}</pre>`;
  }
  return {html, used_numbers: [...used], unknown_numbers: [...unknown], has_protected_syntax: protectedSyntax};
}
