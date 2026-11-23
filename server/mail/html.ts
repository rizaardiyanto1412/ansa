import sanitizeHtml from 'sanitize-html'

const ALLOWED_TAGS = [
  'p', 'br', 'div', 'span', 'a', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'img', 'sub', 'sup', 'small',
]

/**
 * The classes an app's sidebar HTML may use. Ansa styles them (`.app-html` in index.css) so every
 * app looks native; any other class, and every style attribute, is removed. Listed in docs/apps.md.
 */
export const APP_CLASSES = [
  'app-list', 'app-item', 'app-body', 'app-title', 'app-meta', 'app-muted', 'app-label',
  'app-dot', 'app-dot-ok', 'app-dot-warn', 'app-dot-bad', 'app-dot-muted',
  'app-badges', 'app-badge', 'app-badge-ok', 'app-badge-warn', 'app-badge-bad', 'app-badge-info',
  'app-actions', 'app-button', 'app-button-primary', 'app-button-block', 'app-divider',
]

/** Clean untrusted HTML (incoming mail, editor output) down to a small, safe subset. */
export function cleanHtml(html: string): string {
  return sanitizeHtml(html, options()).trim()
}

/** Clean an app's sidebar HTML: the same subset as mail, plus the `app-*` classes Ansa styles. */
export function cleanAppHtml(html: string): string {
  return sanitizeHtml(html, { ...options(), allowedClasses: { '*': APP_CLASSES } }).trim()
}

function options(): sanitizeHtml.IOptions {
  return {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height', 'title'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
      ol: ['start'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'cid', 'data'] },
    allowProtocolRelative: false,
    nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'title', 'head'],
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' },
      }),
    },
    exclusiveFilter: (frame) => frame.tag === 'img' && /^data:(?!image\/(png|jpe?g|gif|webp))/i.test(frame.attribs.src || ''),
  }
}

const TRAILING_ATTRIBUTION = /(<(div|p|span|br)[^<>]{0,300}>\s*)*(On\s[^<]{5,200}\swrote:|Le\s[^<]{5,200}\sa écrit\s?:|Am\s[^<]{5,200}\sschrieb[^<]{0,80}:)\s*(<\/?(div|p|span|br)[^<>]{0,300}>\s*)*$/i
// One pass over opening tags. The attribute part cannot contain "<" and is length-capped, so
// hostile input cannot make this backtrack (mail HTML is untrusted and parsed on the main thread).
const OPEN_TAG = /<(div|blockquote|hr|p|span)\b([^<>]{0,2000})>/gi
const MAX_STRIP_BYTES = 2_000_000

function isQuoteStart(tag: string, attrs: string, after: string): boolean {
  const cls = /\bclass\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? ''
  const id = /\bid\s*=\s*"?([\w-]+)/i.exec(attrs)?.[1] ?? ''
  if ((tag === 'div' || tag === 'blockquote') && /\bgmail_quote\b/.test(cls)) return true
  if (tag === 'blockquote' && /\btype\s*=\s*"?cite/i.test(attrs)) return true
  if (tag === 'div' && /^(divRplyFwdMsg|appendonsend|mail-editor-reference-message-container)$/.test(id)) return true
  if (tag === 'div' && /\b(yahoo_quoted|moz-cite-prefix|protonmail_quote|zmail_extra)\b/.test(cls)) return true
  if (tag === 'hr' && id === 'stopSpelling') return true
  if (tag === 'div' && /border-top:\s*solid\s+#[a-f0-9]{6}\s+1\.0pt/i.test(attrs)) return true
  return tag !== 'blockquote' && tag !== 'hr' && /^\s*-{2,}\s*Original Message\s*-{2,}/i.test(after)
}

/**
 * Remove the quoted history a mail client appends to a reply.
 * Returns the trimmed HTML, or null when nothing was removed or nothing useful would remain.
 */
export function stripQuotedHtml(rawHtml: string): string | null {
  if (rawHtml.length > MAX_STRIP_BYTES) return null
  let cut = -1
  OPEN_TAG.lastIndex = 0
  for (let match = OPEN_TAG.exec(rawHtml); match; match = OPEN_TAG.exec(rawHtml)) {
    if (isQuoteStart(match[1].toLowerCase(), match[2], rawHtml.slice(OPEN_TAG.lastIndex, OPEN_TAG.lastIndex + 60))) {
      cut = match.index
      break
    }
  }
  if (cut <= 0) return null
  // The "On … wrote:" line sits right before the quote. Only look at the tail so this stays cheap.
  const tailStart = Math.max(0, cut - 1500)
  const head = rawHtml.slice(0, tailStart) + rawHtml.slice(tailStart, cut).replace(TRAILING_ATTRIBUTION, '')
  const cleaned = cleanHtml(head)
  return htmlToText(cleaned).trim().length > 0 ? cleaned : null
}

const NOTIFICATION_MARK = /Please (reply|type your reply) above this line/i
const THREAD_HEADER = /<h3[^>]*>\s*(?:<span[^>]*>\s*)?<strong[^>]*>[^<]{1,120}<\/strong>\s*[a-z ]{3,40}?\s*(?:<\/span>\s*)?<\/h3>/gi
const CONTENT_CELL = /<td[^>]*colspan\s*=\s*"?2"?[^>]*>/gi
const NEXT_ITEM = /<tr[^>]*>\s*<td[^>]*>\s*<table[^>]*>\s*<tr[^>]*>\s*<td[^>]*>\s*<table[^>]*>\s*<tr[^>]*>/i
const FOOTER = /<a[^>]*>\s*Notification Settings\s*<\/a>|\{#FS:/i

/**
 * Notification emails from FreeScout-style help desks carry the whole conversation: a header,
 * then every message, newest first. Keep only the newest message.
 * Returns the trimmed HTML, or null when the mail is not such a notification.
 */
export function stripHelpdeskNotification(rawHtml: string): string | null {
  if (rawHtml.length > MAX_STRIP_BYTES || !NOTIFICATION_MARK.test(rawHtml.slice(0, 20_000))) return null
  THREAD_HEADER.lastIndex = 0
  const header = THREAD_HEADER.exec(rawHtml)
  if (!header) return null
  // The message body is the second two-column cell after the header: the first one is a spacer.
  CONTENT_CELL.lastIndex = THREAD_HEADER.lastIndex
  const spacer = CONTENT_CELL.exec(rawHtml)
  const cell = spacer && rawHtml.slice(CONTENT_CELL.lastIndex, CONTENT_CELL.lastIndex + 200).replace(/&nbsp;|\s|\u00a0/g, '').startsWith('</td>') ? CONTENT_CELL.exec(rawHtml) : spacer
  if (!cell) return null
  const start = cell.index + cell[0].length
  const rest = rawHtml.slice(start)
  const ends = [NEXT_ITEM.exec(rest)?.index, FOOTER.exec(rest)?.index].filter((i): i is number => i !== undefined)
  const body = rest.slice(0, ends.length ? Math.min(...ends) : rest.length)
  // Unmatched closing tags from the surrounding table are dropped by the cleaner.
  const cleaned = cleanHtml(body.replace(/\{#FS:[^}]*#\}/g, ''))
  return htmlToText(cleaned).trim().length > 0 ? cleaned : null
}

export const REPLY_MARKER = '-- Please reply above this line --'

/**
 * A teammate's reply to an Ansa notification: keep what they wrote above the quoted notification.
 * Known mail clients are handled by stripQuotedHtml; the marker line catches the rest.
 */
export function replyAboveMarker(rawHtml: string): string {
  const stripped = stripQuotedHtml(rawHtml)
  let html = stripped ?? cleanHtml(rawHtml)
  const at = html.search(NOTIFICATION_MARK)
  if (at >= 0) {
    // Drop the half-open tags and the "On … wrote:" line that lead into the quote.
    const head = html.slice(0, at).replace(/(<[^>]*>|&nbsp;|[\s\u00a0>-])+$/, '').replace(/(On\s[^<]{5,200}\swrote:|Le\s[^<]{5,200}\sa écrit\s?:|Am\s[^<]{5,200}\sschrieb[^<]{0,80}:)\s*$/i, '')
    html = cleanHtml(head)
  }
  return html.replace(/<img[^>]+src="cid:[^>]*>/gi, '').trim()
}

/** The plain-text version of replyAboveMarker. */
export function replyAboveMarkerText(text: string): string {
  let head = stripQuotedText(text) ?? text
  const at = head.search(NOTIFICATION_MARK)
  if (at >= 0) head = head.slice(0, at).replace(/[\s>-]+$/, '').replace(/\n?On\s[^\n]{5,200}\swrote:\s*$/i, '')
  return head.trim()
}

/** Same idea for plain-text mail. Returns null when nothing was removed. */
export function stripQuotedText(text: string): string | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let end = lines.length
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (/^On\s.{5,200}\swrote:$/i.test(line) || /^-{2,}\s*Original Message\s*-{2,}$/i.test(line) || /^_{10,}$/.test(line)) {
      end = i
      break
    }
    // "On ... wrote:" wrapped over two lines by the mail client
    if (/^On\s.{5,200}$/i.test(line) && /wrote:$/i.test((lines[i + 1] || '').trim()) && (lines[i + 2] || '').trim().startsWith('>')) {
      end = i
      break
    }
  }
  if (end === lines.length) {
    let i = lines.length
    while (i > 0 && (lines[i - 1].trim() === '' || lines[i - 1].trimStart().startsWith('>'))) i--
    if (lines.slice(i).some((l) => l.trimStart().startsWith('>'))) end = i
  }
  if (end === lines.length) return null
  const head = lines.slice(0, end).join('\n').trim()
  return head.length > 0 ? head : null
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export { escapeHtml }

/** Turn plain text into simple HTML paragraphs with clickable links. */
export function textToHtml(text: string): string {
  const linked = (segment: string) =>
    escapeHtml(segment).replace(
      /\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g,
      (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>`,
    )
  return text
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${linked(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, '').trim()
      return !text || text === href || href.startsWith('mailto:') ? text || href : `${text} (${href})`
    })
    .replace(/<\/(p|div|h[1-6]|tr|blockquote|pre|ul|ol|table)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+|#39);/gi, (match, code: string) => {
      if (ENTITIES[code.toLowerCase()]) return ENTITIES[code.toLowerCase()]
      if (code[0] === '#') {
        const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
        return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match
      }
      return match
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function previewOf(text: string, length = 180): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > length ? `${flat.slice(0, length - 1).trimEnd()}…` : flat
}

/** Fill {{customer.firstName}}-style placeholders. Unknown placeholders become empty. */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z.]+)\s*\}\}/g, (_m, key: string) => vars[key] ?? '')
}
