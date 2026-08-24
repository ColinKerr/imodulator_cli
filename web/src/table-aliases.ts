/**
 * Finding the table aliases a query declares, so `e.` can complete `bis.Element`'s properties.
 *
 * This reads the FROM and JOIN clauses only. It is deliberately shallow: enough to bind an
 * alias to a class, not an ECSql parser. Anything it cannot recognise it skips, which costs a
 * completion rather than producing a wrong one.
 */

/** A class reference bound to an alias, as written in the query. */
export interface TableAlias {
  /** The schema name or alias written before the class. */
  prefix: string;
  className: string;
  /** The alias itself, as written. */
  alias: string;
}

/** Words that end a table reference, so they are never mistaken for an alias. */
const NOT_AN_ALIAS = new Set([
  "where", "group", "order", "having", "limit", "offset", "join", "inner", "left", "right",
  "full", "outer", "cross", "on", "using", "union", "intersect", "except", "and", "or",
  "options", "ecsqloptions", "only", "all", "as", "select", "from", "with",
]);

/** Keywords that end a FROM or JOIN clause, and so end the list of table references. */
const CLAUSE_END =
  /\b(?:where|group|order|having|limit|offset|union|intersect|except|on|using|join|inner|left|right|full|cross|options|ecsqloptions|select)\b/i;

/** `[schema].[class]`, `schema.class` and `schema:class` are all written in the wild. */
const TABLE_REFERENCE =
  /^\s*(?:only\s+|all\s+)?\[?([A-Za-z_]\w*)\]?\s*[.:]\s*\[?([A-Za-z_]\w*)\]?(?:\s+(?:as\s+)?\[?([A-Za-z_]\w*)\]?)?/i;

/**
 * The aliases a query binds, keyed by the alias in lower case.
 *
 * Each FROM or JOIN introduces a comma separated list of table references, so the clause is
 * taken as a region and split, rather than matched reference by reference: `FROM a.X x, b.Y y`
 * binds both. Only these regions are read, which is what keeps a `SELECT a, b.c` list from
 * being mistaken for a table reference.
 *
 * A later binding of the same alias wins, which matches how a reader would understand the
 * query they are still typing.
 */
export function parseTableAliases(sql: string): Map<string, TableAlias> {
  const aliases = new Map<string, TableAlias>();

  for (const clause of sql.matchAll(/\b(?:from|join)\b/gi)) {
    const rest = sql.slice(clause.index + clause[0].length);
    const ends = CLAUSE_END.exec(rest);
    const region = ends ? rest.slice(0, ends.index) : rest;

    for (const item of region.split(",")) {
      const match = TABLE_REFERENCE.exec(item);
      if (!match)
        continue;
      const [, prefix, className, alias] = match;
      if (!alias || NOT_AN_ALIAS.has(alias.toLowerCase()))
        continue;
      aliases.set(alias.toLowerCase(), { prefix, className, alias });
    }
  }

  return aliases;
}
