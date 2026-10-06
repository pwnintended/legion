/**
 * Agent markdown via streamdown (tolerant of half-streamed markdown), with Legion's own element renderers so no
 * Tailwind classes from the package are needed. Code blocks are highlighted with Shiki (lazy, catppuccin-mocha)
 * once the block is complete. Links open in the default browser, never inside the app window.
 */
import { createElement, memo, type ReactNode, useEffect, useState } from 'react';
import { type Components, Streamdown } from 'streamdown';
import { themeHtml } from '../../theme/palette';

type El = keyof React.JSX.IntrinsicElements;

/** Plain element without streamdown's `node` prop or utility classes. */
function plain(tag: El) {
  const Component = ({ node: _node, className: _className, ...rest }: Record<string, unknown>) =>
    createElement(tag, rest);
  Component.displayName = `md-${tag}`;
  return Component;
}

function openLink(href: string | undefined): void {
  if (!href || !/^https?:\/\//.test(href)) return;
  const bridge = (window as Window & { legion?: { openExternal?: (url: string) => Promise<void> } }).legion;
  if (bridge?.openExternal) void bridge.openExternal(href);
  else window.open(href, '_blank', 'noopener');
}

function Link({ node: _node, href, children }: { node?: unknown; href?: string; children?: ReactNode }) {
  return (
    <a
      href={href}
      title={href}
      onClick={(event) => {
        event.preventDefault();
        openLink(href);
      }}
    >
      {children}
    </a>
  );
}

function textOf(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(textOf).join('');
  if (children && typeof children === 'object' && 'props' in children)
    return textOf((children as { props: { children?: ReactNode } }).props.children);
  return children == null || typeof children === 'boolean' ? '' : String(children);
}

// --- Shiki (lazy) -----------------------------------------------------------------------------

type Highlighter = (code: string, lang: string) => Promise<string>;
let highlighter: Promise<Highlighter> | null = null;
const highlighted = new Map<string, string>();

function getHighlighter(): Promise<Highlighter> {
  highlighter ??= import('shiki').then((shiki) => async (code: string, lang: string) => {
    const language = lang && lang in shiki.bundledLanguages ? lang : 'text';
    return themeHtml(await shiki.codeToHtml(code, { lang: language, theme: 'catppuccin-mocha' }));
  });
  return highlighter;
}

function CodeBlock({ code, lang, live }: { code: string; lang: string; live: boolean }) {
  const key = `${lang}\u0000${code}`;
  const [html, setHtml] = useState(() => highlighted.get(key) ?? null);
  useEffect(() => {
    if (live || highlighted.has(key)) {
      setHtml(highlighted.get(key) ?? null);
      return;
    }
    let cancelled = false;
    getHighlighter()
      .then((highlight) => highlight(code, lang))
      .then((out) => {
        if (highlighted.size > 400) highlighted.clear();
        highlighted.set(key, out);
        if (!cancelled) setHtml(out);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [key, code, lang, live]);
  return (
    <div className="md-code">
      {lang ? <span className="md-code-lang">{lang}</span> : null}
      {html ? (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki escapes the code it highlights.
        <div className="md-code-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="md-code-body">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

function makeComponents(live: boolean): Components {
  const tags: El[] = [
    'p',
    'ul',
    'ol',
    'li',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'strong',
    'em',
    'del',
    'blockquote',
    'hr',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'img',
    'sup',
    'sub',
    'section',
  ];
  const map: Record<string, unknown> = {};
  for (const tag of tags) map[tag] = plain(tag);
  map.a = Link;
  map.inlineCode = ({ children }: { children?: ReactNode }) => <code className="md-inline">{children}</code>;
  map.code = (props: { className?: string; children?: ReactNode }) => {
    const lang = /language-([\w+-]+)/.exec(props.className ?? '')?.[1] ?? '';
    return <CodeBlock code={textOf(props.children).replace(/\n$/, '')} lang={lang} live={live} />;
  };
  return map as Components;
}

const STATIC_COMPONENTS = makeComponents(false);
const LIVE_COMPONENTS = makeComponents(true);

/** Rendered agent markdown. `streaming` tolerates unterminated syntax and shows the caret. */
export const Markdown = memo(function Markdown({
  text,
  streaming,
  caret,
}: {
  text: string;
  streaming: boolean;
  caret: boolean;
}) {
  return (
    <div className={`md${caret ? ' md-caret' : ''}`}>
      <Streamdown
        mode={streaming ? 'streaming' : 'static'}
        parseIncompleteMarkdown={streaming}
        isAnimating={streaming}
        components={streaming ? LIVE_COMPONENTS : STATIC_COMPONENTS}
        linkSafety={{ enabled: false }}
        controls={false}
      >
        {text}
      </Streamdown>
    </div>
  );
});
