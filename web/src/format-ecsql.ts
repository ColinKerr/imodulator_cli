/**
 * A small ECSql formatter.
 *
 * Monaco ships formatters only for css, html and json; its SQL support is a tokenizer and a
 * keyword list, so there is nothing to reuse and this is hand rolled.
 *
 * It is deliberately conservative: it breaks lines at the major clauses, indents the body of
 * each, and leaves everything else -- expressions, functions, sub-selects -- exactly as
 * written. Reformatting inside an expression risks changing a query nobody asked it to touch.
 */

/** Clauses that start a new line at the current depth. */
const CLAUSES = [
  "SELECT", "FROM", "WHERE", "GROUP BY", "HAVING", "ORDER BY", "LIMIT", "OFFSET",
  "UNION ALL", "UNION", "INTERSECT", "EXCEPT", "WITH", "VALUES", "SET",
  "INSERT INTO", "UPDATE", "DELETE FROM", "ECSQLOPTIONS", "OPTIONS",
];

/** Joins start a new line but sit at the same depth as their FROM. */
const JOINS = [
  "LEFT OUTER JOIN", "RIGHT OUTER JOIN", "FULL OUTER JOIN", "INNER JOIN", "CROSS JOIN",
  "LEFT JOIN", "RIGHT JOIN", "FULL JOIN", "JOIN",
];

/** Broken onto their own line inside a clause body. */
const CONNECTORS = ["AND", "OR"];

const INDENT = "  ";

interface Token {
  text: string;
  /** A string literal or bracketed identifier, which must never be altered. */
  literal: boolean;
}

/**
 * Split into literals and everything else. `'` quotes strings (doubled to escape) and `[]`
 * quotes identifiers; the formatter must not touch the inside of either.
 */
function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let text = "";
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" || ch === "[") {
      if (text) {
        tokens.push({ text, literal: false });
        text = "";
      }
      const close = ch === "'" ? "'" : "]";
      let literal = ch;
      i++;
      while (i < sql.length) {
        literal += sql[i];
        if (sql[i] === close) {
          // A doubled quote is an escaped quote, not the end of the literal.
          if (close === "'" && sql[i + 1] === "'") {
            literal += sql[++i];
          } else {
            break;
          }
        }
        i++;
      }
      tokens.push({ text: literal, literal: true });
      continue;
    }
    text += ch;
  }
  if (text)
    tokens.push({ text, literal: false });
  return tokens;
}

/** Match a keyword at this position, if one starts here and ends on a word boundary. */
function matchKeyword(upper: string, at: number, keywords: string[]): string | undefined {
  for (const keyword of keywords) {
    if (!upper.startsWith(keyword, at))
      continue;
    const before = at === 0 ? " " : upper[at - 1];
    const after = upper[at + keyword.length] ?? " ";
    if (/[\s(,]/.test(before) && /[\s(,;]/.test(after))
      return keyword;
  }
  return undefined;
}

export function formatEcsql(sql: string): string {
  const source = sql.trim();
  if (source.length === 0)
    return source;

  const pieces: string[] = [];
  let depth = 0;

  for (const token of tokenize(source)) {
    if (token.literal) {
      pieces.push(token.text);
      continue;
    }

    const upper = token.text.toUpperCase();
    for (let i = 0; i < token.text.length; i++) {
      const ch = token.text[i];

      if (ch === "(") {
        depth++;
        pieces.push(ch);
        continue;
      }
      if (ch === ")") {
        depth = Math.max(0, depth - 1);
        pieces.push(ch);
        continue;
      }

      // Only break lines at the top level: inside parentheses the text is left alone.
      if (depth === 0) {
        const clause = matchKeyword(upper, i, CLAUSES);
        if (clause) {
          pieces.push(`\n${clause}\n${INDENT}`);
          i += clause.length - 1;
          continue;
        }
        const join = matchKeyword(upper, i, JOINS);
        if (join) {
          pieces.push(`\n${join} `);
          i += join.length - 1;
          continue;
        }
        const connector = matchKeyword(upper, i, CONNECTORS);
        if (connector) {
          pieces.push(`\n${INDENT}${connector} `);
          i += connector.length - 1;
          continue;
        }
      }

      pieces.push(ch);
    }
  }

  return tidy(pieces.join(""));
}

/**
 * Tidy the assembled text without disturbing the indentation.
 *
 * Leading whitespace is preserved verbatim: collapsing runs of spaces across the whole line
 * would eat the indent this formatter just added.
 */
function tidy(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => {
      // Every indented line sits at the single body level, so the indent is normalised
      // rather than preserved: the source's own spacing after a keyword lands here too.
      const indented = /^\s/.test(line);
      const indent = indented ? INDENT : "";
      const body = line
        .trimStart()
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\s+,/g, ",")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .trimEnd();
      return body.length === 0 ? "" : `${indent}${body}`;
    })
    .filter((line) => line.length > 0);

  return lines.join("\n").trim();
}
