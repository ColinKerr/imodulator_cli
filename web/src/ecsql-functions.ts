/**
 * The ECSql built-in functions, from the ECSql function reference.
 *
 * Only the ECSql functions are listed. SQLite's scalar functions are also callable but are a
 * separate, much longer reference, and mixing them in would bury these eight.
 */
export interface EcsqlFunction {
  name: string;
  /** Shown beside the name in the completion list. */
  signature: string;
  description: string;
  /** Monaco snippet, so the cursor lands on the first argument. */
  snippet: string;
}

export const ECSQL_FUNCTIONS: EcsqlFunction[] = [
  {
    name: "ec_classname",
    signature: "ec_classname(ecclassId [, format])",
    description: "The name of a class from its id, in the requested format.",
    snippet: "ec_classname(${1:ECClassId})",
  },
  {
    name: "ec_classId",
    signature: "ec_classId('schema-name-or-alias.classname')",
    description: "The id of a class from its name. The schema may be named or aliased.",
    snippet: "ec_classId('${1:BisCore.Element}')",
  },
  {
    name: "REGEXP",
    signature: "REGEXP(regex, value)",
    description: "True when the value matches the regular expression.",
    snippet: "REGEXP('${1:regex}', ${2:value})",
  },
  {
    name: "REGEXP_EXTRACT",
    signature: "REGEXP_EXTRACT(value, regex [, rewrite])",
    description: "The part of the value matching the regular expression.",
    snippet: "REGEXP_EXTRACT(${1:value}, '${2:regex}')",
  },
  {
    name: "StrToGuid",
    signature: "StrToGuid(guid-string)",
    description: "A guid string converted to its binary form.",
    snippet: "StrToGuid(${1:guidString})",
  },
  {
    name: "GuidToStr",
    signature: "GuidToStr(binary-guid)",
    description: "A binary guid converted to its string form.",
    snippet: "GuidToStr(${1:FederationGuid})",
  },
  {
    name: "NAVIGATION_VALUE",
    signature: "NAVIGATION_VALUE(nav-property-path, Id [, RelECClassId])",
    description: "A navigation property value built from an id.",
    snippet: "NAVIGATION_VALUE(${1:bis.Element.Model}, ${2:Id})",
  },
  {
    name: "supports_instance_query",
    signature: "supports_instance_query(class-name-or-class-id)",
    description: "True when the class supports instance queries.",
    snippet: "supports_instance_query(${1:ECClassId})",
  },
];
