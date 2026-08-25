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
 * A navigation property is identified by its type name, not its extended type: measured
 * against a real iModel, `Model` and `Parent` come back as `typeName: "navigation"` with no
 * extended type at all. `NavId` is the extended type of the ECDbMeta *system* property, which
 * is not what a SELECT of a navigation property reports.
 *
 * Ids are the other way round: `ClassId` for a class id and `Id` for an instance id, which is
 * what tells them from an ordinary number without guessing from the column's name.
 */
export function columnKind(column: ColumnInfo): ColumnKind {
  if (column.typeName === "navigation" || column.extendedType === "NavId")
    return "navId";
  switch (column.extendedType) {
    case "ClassId":
      return "classId";
    case "Id":
      return "id";
    default:
      return "plain";
  }
}

/** The shape a navigation property takes in a query result. */
interface NavigationValue {
  Id?: string;
  RelECClassId?: string;
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
  const named = (id: string | undefined): string | undefined =>
    id === undefined ? undefined : classNames.get(id.toLowerCase());

  if (kind === "classId") {
    const name = named(text);
    return name ? { text, annotation: `(${name})` } : { text };
  }

  if (kind === "navId" && typeof value === "object") {
    // A navigation value carries the relationship's class id; naming it says what the
    // reference *is*, which the raw `{"Id":...,"RelECClassId":...}` does not.
    const name = named((value as NavigationValue).RelECClassId);
    return name ? { text, annotation: `(${name})` } : { text };
  }

  return { text };
}

/**
 * Roughly the width one character of the results font occupies, plus the cell's padding.
 * Used only to decide whether a value fits its column; measuring each cell for real would
 * cost a layout pass per row.
 */
const CHAR_WIDTH = 8;
const CELL_PADDING = 24;

/** Roughly how wide a value renders. */
export function contentWidth(value: AugmentedValue): number {
  return (value.text.length + (value.annotation?.length ?? 0)) * CHAR_WIDTH;
}

/** The width a column has for its content, once padding is taken. */
function fittingWidth(columnWidth: number): number {
  return columnWidth - CELL_PADDING;
}

/** Whether a value is too wide for its column, which is what gives the cell a hover. */
export function isTruncated(value: AugmentedValue, columnWidth: number): boolean {
  return contentWidth(value) > fittingWidth(columnWidth);
}

/**
 * Whether a value is more than twice what the column can show.
 *
 * A hover is enough to read a value that only just overflows; past this the value wants the
 * width of the whole row, so its row gets a chevron to expand in place.
 */
export function isExtraLong(value: AugmentedValue, columnWidth: number): boolean {
  return contentWidth(value) > fittingWidth(columnWidth) * 2;
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
