/**
 * The code editor (CodeMirror 6): a file of a checkout, editable and saved with ⌘S, with the usual editor keys
 * (multiple cursors, find and replace, folding, brackets, comment toggling) or vim's, syntax by file name. Its
 * text lives in a buffer (buffers.ts) that outlives the editor on screen; while on screen it looks at the file
 * on disk every couple of seconds, so agents' edits show up (or, under unsaved edits, say they happened).
 */
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state';
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { prefsStore, usePrefs } from '../../../app/prefs';
import { attach, checkDisk, keepState, noteEdit, openBuffer, savedState } from './buffers';
import { editorHighlight, editorTheme } from './theme';

/** How often an editor on screen looks at its file on disk. */
const DISK_MS = 2000;

export interface LineRange {
  start: number;
  end: number;
}

async function vimExtension(): Promise<Extension> {
  const { vim } = await import('@replit/codemirror-vim');
  return vim({ status: true });
}

// Shared slots: a buffer's editor state keeps working when its editor remounts (undo history included).
const vimSlot = new Compartment();
const languageSlot = new Compartment();
const readOnlySlot = new Compartment();
/** Selection callbacks of the editors on screen, by tab (the state's listener outlives any one editor). */
const selectionListeners = new Map<string, (range: LineRange | null) => void>();

function languageFor(path: string): LanguageDescription | null {
  const name = path.split('/').at(-1) ?? path;
  return LanguageDescription.matchFilename(languages, name);
}

export function Editor({
  tabId,
  projectId,
  checkout,
  path,
  text,
  version,
  readOnly,
  reveal,
  revealNonce,
  visible,
  onSelection,
}: {
  tabId: string;
  projectId: string;
  checkout: string | null;
  path: string;
  /** The file's text as read (the buffer's starting point when it has none yet). */
  text: string;
  version: string;
  readOnly: boolean;
  /** Lines to select and scroll to (a search hit, a `path:line`, a reference). */
  reveal: LineRange | null;
  revealNonce: string;
  visible: boolean;
  /** The lines the selection spans (null when it is empty). */
  onSelection: (range: LineRange | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const selectionRef = useRef(onSelection);
  selectionRef.current = onSelection;
  const vimOn = usePrefs((p) => p.editorVim);

  // Mount: the buffer's state when it has one (edits survive tab and workspace switches), else the file's text.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one editor per tab; text and readOnly have their own effects
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    openBuffer(tabId, { projectId, checkout, path, version, text });
    const extensions: Extension[] = [
      vimSlot.of([]),
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),
      languageSlot.of([]),
      readOnlySlot.of(EditorState.readOnly.of(readOnly)),
      editorTheme,
      editorHighlight,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) noteEdit(tabId, update.state.doc.toString());
        if (update.selectionSet || update.docChanged) {
          const report = selectionListeners.get(tabId);
          if (!report) return;
          const main = update.state.selection.main;
          if (main.empty) report(null);
          else {
            const doc = update.state.doc;
            const start = doc.lineAt(main.from).number;
            // A selection that ends at the start of a line does not take that line.
            const endLine = doc.lineAt(main.to);
            const end = main.to === endLine.from && endLine.number > start ? endLine.number - 1 : endLine.number;
            report({ start, end });
          }
        }
      }),
    ];
    selectionListeners.set(tabId, (range) => selectionRef.current(range));
    const editor = new EditorView({
      state: savedState(tabId) ?? EditorState.create({ doc: text, extensions }),
      parent: el,
    });
    view.current = editor;
    editor.dispatch({ effects: readOnlySlot.reconfigure(EditorState.readOnly.of(readOnly)) });
    const detach = attach(tabId, {
      text: () => editor.state.doc.toString(),
      replace: (next) => {
        const head = Math.min(editor.state.selection.main.head, next.length);
        editor.dispatch({
          changes: { from: 0, to: editor.state.doc.length, insert: next },
          selection: EditorSelection.cursor(head),
        });
      },
    });
    const language = languageFor(path);
    if (language)
      void language.load().then((support) => {
        if (view.current === editor) editor.dispatch({ effects: languageSlot.reconfigure(support) });
      });
    if (prefsStore.getState().editorVim)
      void vimExtension().then((ext) => {
        if (view.current === editor) editor.dispatch({ effects: vimSlot.reconfigure(ext) });
      });
    return () => {
      selectionListeners.delete(tabId);
      keepState(tabId, editor.state);
      detach();
      editor.destroy();
      view.current = null;
    };
  }, [tabId]);

  // Vim on or off, live.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    if (!vimOn) {
      editor.dispatch({ effects: vimSlot.reconfigure([]) });
      return;
    }
    let cancelled = false;
    void vimExtension().then((ext) => {
      if (!cancelled && view.current === editor) editor.dispatch({ effects: vimSlot.reconfigure(ext) });
    });
    return () => {
      cancelled = true;
    };
  }, [vimOn]);

  // Read-only follows the workspace (an agent working in the checkout) and the file (truncated, not UTF-8).
  useEffect(() => {
    view.current?.dispatch({ effects: readOnlySlot.reconfigure(EditorState.readOnly.of(readOnly)) });
  }, [readOnly]);

  // Reveal the requested lines.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when a new reveal is requested
  useEffect(() => {
    const editor = view.current;
    if (!editor || !reveal) return;
    const doc = editor.state.doc;
    const from = doc.line(Math.min(Math.max(1, reveal.start), doc.lines)).from;
    const to = doc.line(Math.min(Math.max(1, reveal.end), doc.lines)).to;
    editor.dispatch({
      selection: EditorSelection.range(from, to),
      effects: EditorView.scrollIntoView(from, { y: 'center' }),
    });
  }, [revealNonce]);

  // On screen: look at the file on disk now and every couple of seconds.
  useEffect(() => {
    if (!visible) return;
    void checkDisk(tabId);
    const timer = setInterval(() => void checkDisk(tabId), DISK_MS);
    return () => clearInterval(timer);
  }, [visible, tabId]);

  return <div ref={host} className="ed" data-testid="code-editor" data-read-only={readOnly || undefined} />;
}
