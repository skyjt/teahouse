import MarkdownIt from 'markdown-it'
import katex from 'katex'
import DOMPurify from 'dompurify'

type Markdown = InstanceType<typeof MarkdownIt>

function attrString(token: { attrGet: (name: string) => string | number | null }, name: string): string {
  const value = token.attrGet(name)
  return value == null ? '' : String(value)
}

const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'del',
  's',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'a',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'hr',
  'span',
  'div'
]

const ALLOWED_ATTR = [
  'href',
  'class',
  'title',
  'aria-hidden',
  'aria-label',
  'role',
  'style',
  'colspan',
  'rowspan',
  'align'
]

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderKatex(source: string, displayMode: boolean): string {
  try {
    return katex.renderToString(source, {
      displayMode,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
      output: 'html'
    })
  } catch {
    const tag = displayMode ? 'div' : 'span'
    return `<${tag} class="md-math-fallback">${escapeHtml(source)}</${tag}>`
  }
}

const MATH_SLOT_RE = /@@PANTRY_MATH_(\d+)@@/g

/** 在 markdown-it 解析前把 $...$ / $$...$$ 换成安全占位，渲染后再替换为 KaTeX HTML。 */
function extractMath(src: string): { text: string; slots: string[] } {
  const slots: string[] = []
  let text = src.replace(/\$\$([\s\S]+?)\$\$/g, (_match, body: string) => {
    const index = slots.length
    slots.push(renderKatex(body.trim(), true))
    return `@@PANTRY_MATH_${index}@@`
  })
  text = text.replace(/(^|[^\\$])\$([^\n$]+?)\$/g, (_match, prefix: string, body: string) => {
    const index = slots.length
    slots.push(renderKatex(body.trim(), false))
    return `${prefix}@@PANTRY_MATH_${index}@@`
  })
  return { text, slots }
}

function restoreMath(html: string, slots: string[]): string {
  return html.replace(MATH_SLOT_RE, (_match, indexText: string) => {
    const index = Number(indexText)
    return slots[index] ?? ''
  })
}

function createMarkdownIt(): Markdown {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: true,
    typographer: false
  })

  // 图片不自动拉源：降级为可点击链接或纯文本（纯内网、防外联探测）
  md.renderer.rules.image = (tokens, idx): string => {
    const token = tokens[idx]
    const src = attrString(token, 'src')
    const alt = token.content || src
    if (/^https?:\/\//i.test(src)) {
      return `<a href="${escapeHtml(src)}">${escapeHtml(alt || src)}</a>`
    }
    return escapeHtml(alt || src)
  }

  const defaultLinkOpen =
    md.renderer.rules.link_open ??
    ((tokens, idx, options, _env, self): string => self.renderToken(tokens, idx, options))

  md.renderer.rules.link_open = (tokens, idx, options, env, self): string => {
    const token = tokens[idx]
    const href = attrString(token, 'href')
    if (!/^https?:\/\//i.test(href)) {
      token.attrSet('href', '')
      token.attrJoin('class', 'md-link-blocked')
    } else {
      token.attrSet('rel', 'noopener noreferrer')
      token.attrJoin('class', 'md-link')
    }
    return defaultLinkOpen(tokens, idx, options, env, self)
  }

  return md
}

let mdInstance: Markdown | null = null

function markdown(): Markdown {
  if (!mdInstance) mdInstance = createMarkdownIt()
  return mdInstance
}

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['img', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
    FORBID_ATTR: ['src', 'srcset', 'xlink:href']
  })
}

/** 将聊天正文渲染为消毒后的 HTML（GFM 子集 + LaTeX）。 */
export function renderMarkdown(text: string): string {
  if (!text) return ''
  const { text: withSlots, slots } = extractMath(text)
  const rendered = markdown().render(withSlots)
  return sanitize(restoreMath(rendered, slots))
}

export function isSafeHttpUrl(href: string): boolean {
  return /^https?:\/\//i.test(href.trim())
}