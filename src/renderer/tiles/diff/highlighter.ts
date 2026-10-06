/**
 * Shiki, configured once: Catppuccin Mocha, the JavaScript regex engine (no WASM, CSP-friendly) and a fixed
 * set of grammars imported statically so the worker bundle needs no code splitting. Runs in the highlight
 * worker, or on the main thread as a fallback.
 */
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import css from 'shiki/langs/css.mjs';
import go from 'shiki/langs/go.mjs';
import javascript from 'shiki/langs/javascript.mjs';
import json from 'shiki/langs/json.mjs';
import jsx from 'shiki/langs/jsx.mjs';
import python from 'shiki/langs/python.mjs';
import rust from 'shiki/langs/rust.mjs';
import shellscript from 'shiki/langs/shellscript.mjs';
import sql from 'shiki/langs/sql.mjs';
import toml from 'shiki/langs/toml.mjs';
import tsx from 'shiki/langs/tsx.mjs';
import typescript from 'shiki/langs/typescript.mjs';
import yaml from 'shiki/langs/yaml.mjs';
import mocha from 'shiki/themes/catppuccin-mocha.mjs';

/** One token: text and colour (null = default text colour); `i` = italic. */
export interface Tok {
  t: string;
  c: string | null;
  i?: 1;
}

export interface HighlightRequest {
  id: number;
  lang: string;
  blocks: string[];
}

export interface HighlightResponse {
  id: number;
  /** Per block, per line, the tokens; null when the language is unknown or highlighting failed. */
  blocks: (Tok[][] | null)[];
}

let highlighter: Promise<HighlighterCore> | null = null;

function get(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [mocha],
    langs: [typescript, tsx, javascript, jsx, json, sql, css, yaml, shellscript, python, go, rust, toml],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighter;
}

const DEFAULT_FG = '#cdd6f4';

export async function highlight(request: HighlightRequest): Promise<HighlightResponse> {
  const h = await get();
  const known = h.getLoadedLanguages().includes(request.lang);
  return {
    id: request.id,
    blocks: request.blocks.map((code) => {
      if (!known) return null;
      try {
        return h.codeToTokensBase(code, { lang: request.lang, theme: 'catppuccin-mocha' }).map((line) =>
          line.map((token) => {
            const color = token.color && token.color.toLowerCase() !== DEFAULT_FG ? token.color : null;
            return (token.fontStyle ?? 0) & 1
              ? { t: token.content, c: color, i: 1 as const }
              : { t: token.content, c: color };
          }),
        );
      } catch {
        return null;
      }
    }),
  };
}
