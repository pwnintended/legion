/**
 * The editor's look, from the palette variables only (so Mocha and Latte are one theme): the base ground, mono
 * text, a mantle gutter, the mauve caret and selection the app uses everywhere, and Catppuccin's own syntax
 * colours (the same ones the diff viewer's highlighter uses), which belong to the code, not to the UI's signals.
 */
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

const v = (name: string) => `var(--${name})`;

export const editorTheme: Extension = EditorView.theme({
  '&': {
    height: '100%',
    color: v('text'),
    backgroundColor: v('base'),
    fontSize: '12.5px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: v('font-code'),
    lineHeight: '1.65',
    fontVariantLigatures: 'none',
  },
  '.cm-content': { caretColor: v('mauve'), padding: '8px 0 40vh' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: v('mauve'), borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--mauve) 26%, transparent)',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--surface0) 38%, transparent)' },
  '.cm-gutters': {
    backgroundColor: v('base'),
    color: v('overlay0'),
    border: 'none',
    paddingRight: '6px',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 14px', minWidth: '4ch' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: v('subtext0') },
  '.cm-foldGutter .cm-gutterElement': { color: v('overlay0') },
  '.cm-foldPlaceholder': {
    backgroundColor: v('surface0'),
    border: 'none',
    color: v('subtext0'),
    borderRadius: '4px',
    padding: '0 5px',
  },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--lavender) 18%, transparent)',
    outline: '1px solid color-mix(in srgb, var(--lavender) 40%, transparent)',
  },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--lavender) 14%, transparent)' },
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in srgb, var(--yellow) 22%, transparent)',
    outline: '1px solid color-mix(in srgb, var(--yellow) 45%, transparent)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--yellow) 40%, transparent)' },
  // The search panel, as one of the app's own: mantle strip, fields like the app's fields.
  '.cm-panels': { backgroundColor: v('mantle'), color: v('text'), fontFamily: v('font-ui') },
  '.cm-panels.cm-panels-top': { borderBottom: `1px solid ${v('hairline')}` },
  '.cm-panels.cm-panels-bottom': { borderTop: `1px solid ${v('hairline')}` },
  '.cm-panel.cm-search': { padding: '8px 10px', fontSize: '12px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontFamily: v('font-ui'), fontSize: '12px' },
  '.cm-textfield': {
    backgroundColor: v('base'),
    color: v('text'),
    border: `1px solid ${v('surface0')}`,
    borderRadius: '6px',
    padding: '3px 8px',
  },
  '.cm-textfield:focus': { borderColor: v('mauve'), outline: 'none' },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: v('surface0'),
    color: v('text'),
    border: 'none',
    borderRadius: '6px',
    padding: '3px 9px',
  },
  '.cm-button:hover': { backgroundColor: v('surface1') },
  '.cm-panel.cm-search label': { color: v('subtext0') },
  '.cm-panel.cm-search input[type=checkbox]': { accentColor: v('mauve') },
  '.cm-panel button[name=close]': { color: v('overlay2') },
  '.cm-tooltip': {
    backgroundColor: v('crust'),
    color: v('text'),
    border: `1px solid ${v('surface1')}`,
    borderRadius: '8px',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: v('surface0'), color: v('text') },
  // Vim's command line and its fat cursor.
  '.cm-vim-panel': { fontFamily: v('font-code'), padding: '2px 10px', fontSize: '12px' },
  '.cm-vim-panel input': { color: v('text'), fontFamily: v('font-code') },
  '.cm-fat-cursor': { background: 'color-mix(in srgb, var(--mauve) 70%, transparent)', color: v('crust') },
  '&:not(.cm-focused) .cm-fat-cursor': { background: 'none', outline: `1px solid ${v('mauve')}` },
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: v('mauve') },
  { tag: [t.string, t.special(t.string), t.character], color: v('green') },
  { tag: [t.number, t.bool, t.null, t.atom], color: v('peach') },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: v('blue') },
  { tag: [t.typeName, t.className, t.namespace], color: v('yellow') },
  { tag: [t.propertyName, t.attributeName], color: v('lavender') },
  { tag: [t.definition(t.variableName)], color: v('text') },
  { tag: [t.variableName, t.labelName], color: v('text') },
  { tag: [t.self, t.special(t.variableName)], color: v('red') },
  { tag: [t.operator, t.derefOperator], color: v('sky') },
  { tag: [t.punctuation, t.separator, t.bracket], color: v('overlay2') },
  { tag: [t.regexp, t.escape], color: v('pink') },
  { tag: [t.tagName], color: v('blue') },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: v('overlay2'), fontStyle: 'italic' },
  { tag: [t.meta, t.annotation], color: v('yellow') },
  { tag: t.heading, color: v('red'), fontWeight: '600' },
  { tag: [t.link, t.url], color: v('blue'), textDecoration: 'underline' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.invalid, color: v('red') },
  { tag: [t.inserted], color: v('green') },
  { tag: [t.deleted], color: v('red') },
]);

export const editorHighlight: Extension = syntaxHighlighting(highlight);
