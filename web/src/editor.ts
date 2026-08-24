import * as monaco from "monaco-editor";
import { formatEcsql } from "./format-ecsql";
import type { SchemaInfo } from "./schema-info";

/** ECSql keywords for completion. Monaco's sql tokenizer colors these already. */
const KEYWORDS = [
  "SELECT", "FROM", "WHERE", "GROUP BY", "HAVING", "ORDER BY", "LIMIT", "OFFSET", "AS",
  "JOIN", "INNER JOIN", "LEFT JOIN", "ON", "AND", "OR", "NOT", "IN", "IS", "NULL", "LIKE",
  "BETWEEN", "CASE", "WHEN", "THEN", "ELSE", "END", "DISTINCT", "COUNT", "SUM", "AVG",
  "MIN", "MAX", "WITH", "UNION", "UNION ALL", "ONLY", "ECSQLOPTIONS", "PRAGMA",
];

export interface ConsoleEditor {
  /** The text to run: the selection if there is one, otherwise everything. */
  textToRun(): string;
  value(): string;
  format(): void;
  onChange(listener: () => void): void;
  onRun(listener: () => void): void;
  setSchemaInfo(info: SchemaInfo): void;
  layout(): void;
}

export function createEditor(container: HTMLElement): ConsoleEditor {
  let schemaInfo: SchemaInfo | undefined;

  monaco.languages.register({ id: "ecsql" });
  monaco.languages.setMonarchTokensProvider("ecsql", {
    ignoreCase: true,
    keywords: KEYWORDS,
    tokenizer: {
      root: [
        [/--.*$/, "comment"],
        [/'([^'\\]|\\.|'')*'/, "string"],
        [/\[[^\]]*\]/, "identifier"],
        [/\b0x[0-9a-fA-F]+\b/, "number.hex"],
        [/\b\d+(\.\d+)?\b/, "number"],
        [/[a-zA-Z_]\w*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
      ],
    },
  });

  // Monaco has no SQL formatter of its own -- it ships one only for css, html and json --
  // so the console's formatter is registered here to serve the editor's format action too.
  monaco.languages.registerDocumentFormattingEditProvider("ecsql", {
    provideDocumentFormattingEdits: (model) => [
      { range: model.getFullModelRange(), text: formatEcsql(model.getValue()) },
    ],
  });

  monaco.languages.registerCompletionItemProvider("ecsql", {
    triggerCharacters: ["."],
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const line = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });

      const suggestions: monaco.languages.CompletionItem[] = [];
      const qualifier = /([A-Za-z_]\w*)\.(?:[A-Za-z_]\w*)?$/.exec(line)?.[1];

      if (qualifier && schemaInfo) {
        // After `Schema.` offer that schema's classes; after `Class.` offer its properties.
        for (const className of schemaInfo.classesBySchema.get(qualifier) ?? [])
          suggestions.push({ label: className, kind: monaco.languages.CompletionItemKind.Class, insertText: className, range });
        for (const [classKey, properties] of schemaInfo.propertiesByClass) {
          if (!classKey.endsWith(`.${qualifier}`))
            continue;
          for (const property of properties)
            suggestions.push({ label: property, kind: monaco.languages.CompletionItemKind.Field, insertText: property, range });
        }
      }

      if (suggestions.length === 0) {
        for (const keyword of KEYWORDS)
          suggestions.push({ label: keyword, kind: monaco.languages.CompletionItemKind.Keyword, insertText: keyword, range });
        for (const schemaName of schemaInfo?.classesBySchema.keys() ?? [])
          suggestions.push({ label: schemaName, kind: monaco.languages.CompletionItemKind.Module, insertText: schemaName, range });
      }

      return { suggestions };
    },
  });

  const editor = monaco.editor.create(container, {
    value: "",
    language: "ecsql",
    theme: "vs",
    automaticLayout: false,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 13,
  });

  const runListeners: (() => void)[] = [];
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
    for (const listener of runListeners)
      listener();
  });

  return {
    value: () => editor.getValue(),
    textToRun: () => {
      const selection = editor.getSelection();
      const selected = selection && !selection.isEmpty() ? editor.getModel()?.getValueInRange(selection) : undefined;
      const trimmed = selected?.trim();
      return trimmed && trimmed.length > 0 ? trimmed : editor.getValue().trim();
    },
    format: () => {
      const model = editor.getModel();
      if (model)
        editor.executeEdits("format", [{ range: model.getFullModelRange(), text: formatEcsql(model.getValue()) }]);
    },
    onChange: (listener) => { editor.onDidChangeModelContent(() => listener()); },
    onRun: (listener) => { runListeners.push(listener); },
    setSchemaInfo: (info) => { schemaInfo = info; },
    layout: () => editor.layout(),
  };
}
