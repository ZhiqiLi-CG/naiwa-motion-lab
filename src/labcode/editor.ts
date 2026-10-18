/** The code editor: CodeMirror with TypeScript, the page's colour tokens (both themes), problems marked inline, and
 *  Ctrl/Cmd+S to apply. */
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { basicSetup } from "codemirror";

export interface EditorProblem {
  from: number;
  to: number;
  message: string;
  severity: "error" | "warning";
}

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--bg-raised)", color: "var(--text-primary)", fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "20px" },
  ".cm-content": { caretColor: "var(--text-primary)", padding: "8px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text-primary)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--bg-selected) !important" },
  ".cm-gutters": { backgroundColor: "var(--bg-sunken)", color: "var(--text-tertiary)", border: "none", borderRight: "1px solid var(--border-subtle)" },
  ".cm-activeLine": { backgroundColor: "var(--bg-hover)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--bg-active)", color: "var(--text-secondary)" },
  ".cm-matchingBracket": { backgroundColor: "var(--accent-soft)", outline: "1px solid var(--accent-border)" },
  ".cm-searchMatch": { backgroundColor: "var(--warning-soft)", outline: "1px solid var(--accent-border)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--bg-active)", border: "none", color: "var(--text-secondary)" },
  ".cm-tooltip": { backgroundColor: "var(--bg-raised)", color: "var(--text-primary)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-md)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--bg-selected)", color: "var(--text-primary)" },
  ".cm-diagnostic": { fontFamily: "var(--font-sans)", fontSize: "12px", padding: "4px 8px" },
  ".cm-diagnostic-error": { borderLeft: "3px solid var(--danger)" },
  ".cm-diagnostic-warning": { borderLeft: "3px solid var(--accent-edge)" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--danger)", textUnderlineOffset: "3px" },
  ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline wavy var(--accent-edge)", textUnderlineOffset: "3px" },
  ".cm-panels": { backgroundColor: "var(--bg-surface)", color: "var(--text-primary)" },
  ".cm-textfield": { backgroundColor: "var(--bg-raised)", color: "var(--text-primary)", border: "1px solid var(--border)" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--bg-sunken)", color: "var(--text-primary)", border: "1px solid var(--border)" },
});

/** Syntax colours from the text tokens, so each stays readable (WCAG AA) on the editor's surface in both themes. */
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--info-text)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--success-text)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--warning-text)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--text-tertiary)", fontStyle: "italic" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--accent-text)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--leaf-text)" },
  { tag: t.invalid, color: "var(--danger-text)" },
]);

export function createEditor(parent: HTMLElement, opts: { onChange(): void; onSave(): void; label: string }) {
  const readOnly = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "",
      extensions: [
        keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (opts.onSave(), true) }]),
        basicSetup,
        javascript({ typescript: true }),
        syntaxHighlighting(highlight),
        lintGutter(),
        theme,
        readOnly.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]),
        EditorView.contentAttributes.of({ "aria-label": opts.label }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) opts.onChange();
        }),
      ],
    }),
  });
  return {
    view,
    /** Show this code; read-only for the page's own sources. */
    set(code: string, editable: boolean) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: code },
        effects: readOnly.reconfigure(editable ? [] : [EditorState.readOnly.of(true), EditorView.editable.of(false)]),
        selection: { anchor: 0 },
        scrollIntoView: true,
      });
      view.dispatch(setDiagnostics(view.state, []));
    },
    get: () => view.state.doc.toString(),
    problems(list: EditorProblem[]) {
      const len = view.state.doc.length;
      const d: Diagnostic[] = list.map((p) => {
        const from = Math.max(0, Math.min(p.from, len));
        return { from, to: Math.max(from, Math.min(p.to, len)), message: p.message, severity: p.severity };
      });
      view.dispatch(setDiagnostics(view.state, d));
    },
    /** Put the cursor at a position and show it. */
    reveal(pos: number) {
      const at = Math.max(0, Math.min(pos, view.state.doc.length));
      view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
      view.focus();
    },
    lineCol(pos: number): [number, number] {
      const line = view.state.doc.lineAt(Math.max(0, Math.min(pos, view.state.doc.length)));
      return [line.number, pos - line.from + 1];
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}

export type Editor = ReturnType<typeof createEditor>;
