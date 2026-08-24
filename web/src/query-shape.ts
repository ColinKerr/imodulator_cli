/** Pure helpers shared by the console. Kept free of DOM and iTwin.js so they can be tested. */

/** What the editor should run: the selection if there is one, otherwise everything. */
export function textToRun(all: string, selected: string | undefined): string {
  const selection = selected?.trim();
  return selection && selection.length > 0 ? selection : all.trim();
}

/**
 * Wrap a query so it yields its own row count.
 *
 * ECSql supports a sub-select in FROM, so the original query is not rewritten -- it becomes a
 * derived table and its own text is left intact. A trailing semicolon would break that, so it
 * is dropped.
 */
export function countQuery(ecsql: string): string {
  return `SELECT COUNT(*) FROM (${ecsql.trim().replace(/;\s*$/, "")})`;
}

/**
 * Wrap a query in the pragma that explains it.
 *
 * Quotes are doubled because the query travels inside a string literal.
 */
export function explainQuery(ecsql: string): string {
  return `PRAGMA explain_query('${ecsql.trim().replace(/;\s*$/, "").replaceAll("'", "''")}')`;
}

/** Column metadata, as much of `QueryPropertyMetaData` as the console needs. */
export interface ColumnInfo {
  name: string;
  jsonName: string;
  typeName: string;
  extendedType?: string;
  className: string;
}

/** How a column's values should be rendered. */
export type ColumnKind = "classId" | "id" | "navId" | "plain";

/**
 * Classify a column from its metadata.
 *
 * ECDb reports an extended type of `ClassId` for class ids, `Id` for instance ids and `NavId`
 * for navigation properties, which is what distinguishes an id column from an ordinary
 * number without guessing from the column's name.
 */
export function columnKind(column: ColumnInfo): ColumnKind {
  switch (column.extendedType) {
    case "ClassId":
      return "classId";
    case "NavId":
      return "navId";
    case "Id":
      return "id";
    default:
      return "plain";
  }
}

/** A class id rendered as `0x42 (BisCore.Element)`, with the name looked up separately. */
export interface AugmentedValue {
  text: string;
  /** Present when the value resolved to a schema class, shown in lighter type. */
  annotation?: string;
}

export function augmentValue(
  value: unknown,
  kind: ColumnKind,
  classNames: ReadonlyMap<string, string>,
): AugmentedValue {
  if (value === null || value === undefined)
    return { text: "" };

  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (kind !== "classId")
    return { text };

  const name = classNames.get(text.toLowerCase());
  return name ? { text, annotation: `(${name})` } : { text };
}

/** Escape one CSV cell, quoting only when it has to. */
export function toCsvCell(value: unknown): string {
  if (value === null || value === undefined)
    return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(columns: string[], rows: unknown[][]): string {
  const lines = [columns.map(toCsvCell).join(",")];
  for (const row of rows)
    lines.push(row.map(toCsvCell).join(","));
  return `${lines.join("\n")}\n`;
}
