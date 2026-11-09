/**
 * The client's half of a turn: running the queries the function asks for and reading their rows,
 * and running the startup query list before the first turn.
 *
 * The function never reaches the iModel. Each response names the queries to run and the caps to
 * read them to; the client runs them on its own iModel and sends the rows with the next turn.
 */

import { readCapped, type RunRawQuery } from "./caps";
import type { ResultPages } from "./result-pages";
import {
  HISTORY_CAPS, type AnswerMode, type ResultType, type EarlierQuestion, type QueryRows, type ResultCaps, type StartupResult, type StopReason, type SubmittedAnswer,
  type TurnRequest, type TurnResponse,
} from "./turn-api";

/** What the client supplies to a run, wherever the function runs. */
export interface ClientOptions {
  /** Absent when no iModel is open: the agent is told so and `runQuery` is not offered. */
  runQuery?: RunRawQuery;
  /** The open iModel: its name, and the rows of the startup query list (`runStartupQueries`), run once per iModel. */
  imodel?: { name: string; startup?: StartupResult[] };
  editorText?: string;
  /** The chat's earlier questions, oldest first (`earlierQuestion`). The function shortens them to fit. */
  earlier?: readonly EarlierQuestion[];
  /** The token of the chat's last finished run. Opaque: kept and sent back, never read. */
  token?: string;
  /** How the answer is to be given (`AnswerMode`). Sent with every turn. */
  answerMode?: AnswerMode;
  /** Called before each turn is sent (`thinking`), and before each query runs (`querying`, with its ECSql). */
  onPhase?: (phase: "thinking" | "querying", ecsql?: string) => void;
  signal?: AbortSignal;
}

/** The finished run, as the client keeps it: the answer, and what the chat's next question needs. */
export interface AgentRun {
  /** The final prose answer, which should carry exactly one fenced sql block. */
  answer: string;
  /** The query pulled out of the answer, if there was one. */
  query?: string;
  stoppedBecause: StopReason;
  /** The answer as submitted, when the run ended that way. */
  structured?: SubmittedAnswer;
  /** Names the run's record, where the function keeps one. */
  runId: string;
  /** The token for the chat's next question.*/
  token: string;
  /** The answer mode the run was asked in, as the host sent it. */
  answerMode?: AnswerMode;
  /**
   * In the `auto` and `select` modes: what the answer is (`done.resultType`). `selection`: its
   * query is the selection, and no rows clears it. `answer`: select its rows only when they carry
   * `ECInstanceId` and `ClassName`.
   */
  resultType?: ResultType;
  /** The answer's query's rows, read once when the run ended (`AgentClient.ask`), or its error. */
  answerRows?: AnswerRows;
  /**
   * All the answer's rows, with no limit, read a page at a time as a table asks for them. Present
   * when the answer has a query and there is an iModel. For the host only: never sent to the function.
   */
  results?: ResultPages;
}

/** An answer's query's rows, as the client read them, or the error it gave. */
export type AnswerRows = Pick<QueryRows, "columns" | "rows" | "clipped" | "truncatedBy" | "error">;

/**
 * An answered question as a later question of the chat sends it: as the user saw it, with the
 * answer's rows cut to `HISTORY_CAPS`.
 */
export async function earlierQuestion(question: string, run: AgentRun): Promise<EarlierQuestion> {
  const query = run.structured?.query || run.query;
  return {
    question,
    answer: run.answer,
    ...(query ? { query } : {}),
    ...(run.answerRows ? { rows: await historyRows(run.answerRows) } : {}),
    stoppedBecause: run.stoppedBecause,
  };
}

/**
 * Rows read with the live caps, cut again to `HISTORY_CAPS`, by the same rule as a read. A cell the
 * first read already cut keeps its full length.
 */
async function historyRows(read: AnswerRows): Promise<AnswerRows> {
  if (read.error !== undefined)
    return { error: read.error };
  const cut = await readCapped({ columns: read.columns ?? [], rows: (async function* () { yield* read.rows ?? []; })() }, HISTORY_CAPS);
  const before = new Map((read.clipped ?? []).map(([row, column, length]) => [`${row},${column}`, length]));
  const clipped = (cut.clipped ?? []).map(([row, column, length]): [number, number, number] => [row, column, before.get(`${row},${column}`) ?? length]);
  for (const [key, length] of before) {
    const [row, column] = key.split(",").map(Number);
    if (row < (cut.rows?.length ?? 0) && !clipped.some(([r, c]) => r === row && c === column))
      clipped.push([row, column, length]);
  }
  const truncatedBy = cut.truncatedBy ?? read.truncatedBy;
  return { columns: cut.columns, rows: cut.rows, ...(clipped.length > 0 ? { clipped } : {}), ...(truncatedBy ? { truncatedBy } : {}) };
}

/** One call to the function: over HTTP (`fetchTurns`), or in the same process, for tests. */
export type TurnCall = (request: TurnRequest, signal?: AbortSignal) => Promise<TurnResponse>;

/**
 * Drive a run: send a turn, run the queries the response asks for, send their rows with the next
 * turn, until the response says the run is over. When the user stops the run, the next turn says
 * so, and the function ends it.
 */
export async function driveTurns(question: string, client: ClientOptions, turn: TurnCall): Promise<AgentRun> {
  const { runQuery } = client;
  let token = client.token;
  let results: QueryRows[] | undefined;
  for (;;) {
    const request: TurnRequest = {
      question, canQuery: runQuery !== undefined, imodel: client.imodel, editorText: client.editorText,
      ...(client.earlier && client.earlier.length > 0 ? { earlier: [...client.earlier] } : {}),
      ...(token ? { token } : {}),
      ...(results ? { results } : {}),
      ...(client.signal?.aborted ? { aborted: true } : {}),
      ...(client.answerMode ? { answerMode: client.answerMode } : {}),
    };
    client.onPhase?.("thinking");
    const response: TurnResponse = await turn(request, client.signal);
    token = response.token;
    const done = response.done;
    if (done) {
      return {
        answer: done.answer,
        ...(done.query ? { query: done.query } : {}),
        stoppedBecause: done.stoppedBecause,
        ...(done.structured ? { structured: done.structured } : {}),
        runId: done.runId,
        token: response.token,
        ...(done.resultType ? { resultType: done.resultType } : {}),
      };
    }
    results = [];
    for (const ecsql of response.queries) {
      client.onPhase?.("querying", ecsql);
      results.push(await readQuery(runQuery!, ecsql, response.caps));
    }
  }
}

/** The refusals a user can act on: a chat to start again (400), a key to give or replace (401, 403), too long a request (413), a key used up (429). */
const REFUSALS = new Set([400, 401, 403, 413, 429]);

/**
 * The function refused a turn for a reason the user can act on. `message` is the function's one
 * sentence, meant to be shown as it is; `status` says which: 401 or 403 ask for an access key, 429
 * means the key is used up, which can happen in the middle of a question, 413 means the request is
 * too long, 400 means the chat must start again.
 */
export class TurnRefused extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "TurnRefused";
  }
}

export interface FetchTurnsOptions {
  /**
   * The user's credential for the function, sent with every turn as `Authorization: Bearer <it>`:
   * the access key the owner gave them. A function that checks access refuses a turn without one
   * (`TurnRefused`, 401).
   */
  getAccessToken?: () => Promise<string | undefined>;
}

/**
 * Turns over HTTP: `POST <url>/turn`, the same code in a browser and in Node. When the user stops
 * the run while a turn is in flight, the same turn is sent again, saying the run was stopped, so
 * the function ends it with what it has.
 */
export function fetchTurns(url: string, options: FetchTurnsOptions = {}): TurnCall {
  const post = async (request: TurnRequest, signal?: AbortSignal): Promise<TurnResponse> => {
    const token = await options.getAccessToken?.();
    const response = await fetch(`${url.replace(/\/+$/, "")}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(request),
      signal,
    });
    const body = await response.json() as TurnResponse | { error?: string };
    const reason = (body as { error?: string }).error;
    if (!response.ok && REFUSALS.has(response.status) && reason)
      throw new TurnRefused(response.status, reason);
    if (!response.ok)
      throw new Error(`The agent function refused the turn (HTTP ${response.status}): ${reason ?? "no reason given"}`);
    return body as TurnResponse;
  };
  return async (request, signal) => {
    // The turn that says the run was stopped must get through, so it is not tied to the signal.
    if (request.aborted)
      return post(request);
    try {
      return await post(request, signal);
    } catch (err) {
      if (!signal?.aborted)
        throw err;
      return post({ ...request, aborted: true });
    }
  };
}

/**
 * Run one query and read it up to the caps. A failure, at the start or part way through the
 * rows, is sent as the query's error: the function hands it to the model to correct.
 */
export async function readQuery(runQuery: RunRawQuery, ecsql: string, caps: ResultCaps): Promise<QueryRows> {
  const started = Date.now();
  try {
    const read = await readCapped(await runQuery(ecsql), caps);
    return { ecsql, ...read, ms: Date.now() - started };
  } catch (err) {
    return { ecsql, error: err instanceof Error ? err.message : String(err), ms: Date.now() - started };
  }
}

/** One query of the startup list. */
export interface StartupQuery {
  rule: string;
  id: string;
  ecsql: string;
  /** Rows sent. The rest are counted, not sent. */
  max?: number;
  /** Run only when these queries of the same rule were empty. */
  onlyIfEmpty?: string[];
  /** A second query run for every row sent, with the row's columns as `{0}`, `{1}`. It always runs to the end. */
  each?: string;
}

/** The startup query list (`startup-queries.json`), which the client library carries. */
export interface StartupList {
  description?: string[];
  lists: Record<string, string[]>;
  queries: StartupQuery[];
}

/** One startup query run, for a report of what was asked and how long it took. */
export interface QueryReport {
  rule: string;
  query: string;
  ecsql: string;
  ms: number;
  rows: number;
  skipped?: boolean;
  /** A failed query is an empty one: the class or schema is not in this file. */
  error?: string;
}

/** How many result rows are read at most, whatever `max` says: a guard, not a display limit. */
const ROW_GUARD = 500;

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Expand `{{in:list}}`, `{{like:expr:list}}` and `{{notlike:expr:list}}`. An unknown list throws. */
export function expandLists(ecsql: string, lists: Record<string, string[]>): string {
  return ecsql.replace(/\{\{(in|like|notlike):([^}]+)\}\}/g, (_whole, kind: string, rest: string) => {
    const at = rest.lastIndexOf(":");
    const name = kind === "in" ? rest : rest.slice(at + 1);
    const values = lists[name];
    if (!values || values.length === 0)
      throw new Error(`startup list: no list named "${name}"`);
    if (kind === "in")
      return values.map(quote).join(", ");
    const expression = rest.slice(0, at);
    const terms = values.map((value) => `${expression} ${kind === "like" ? "LIKE" : "NOT LIKE"} ${quote(value.includes("%") ? value : `%${value}%`)}`);
    return `(${terms.join(kind === "like" ? " OR " : " AND ")})`;
  });
}

/**
 * A row's values inside the `each` query. They come from the file and land inside `[...]`, so
 * a value that could close the bracket is refused; the row then sends null for `each`.
 */
function fillIdentifiers(template: string, row: unknown[]): string | undefined {
  let safe = true;
  const text = template.replace(/\{(\d+)\}/g, (_whole, index: string) => {
    const value = String(row[Number(index)] ?? "");
    if (!/^[A-Za-z0-9_]+$/.test(value))
      safe = false;
    return value;
  });
  return safe ? text : undefined;
}

async function readRows(runQuery: RunRawQuery, ecsql: string): Promise<unknown[][]> {
  const result = await runQuery(ecsql);
  const rows: unknown[][] = [];
  for await (const row of result.rows) {
    rows.push(row);
    if (rows.length >= ROW_GUARD)
      break;
  }
  return rows;
}

/** No rows, or the single cell of a count that came back 0. The function applies the same test. */
function isEmpty(rows: unknown[][]): boolean {
  return rows.length === 0 || (rows.length === 1 && rows[0].length === 1 && (rows[0][0] === 0 || rows[0][0] === null));
}

/**
 * Run the startup list on the open iModel. Never throws for a query: a failure is an empty
 * result. Only a list that names a list it does not define throws.
 */
export async function runStartupQueries(list: StartupList, runQuery: RunRawQuery): Promise<{ results: StartupResult[]; reports: QueryReport[] }> {
  const results: StartupResult[] = [];
  const reports: QueryReport[] = [];
  const emptyByRule = new Map<string, Set<string>>();
  for (const query of list.queries) {
    const empty = emptyByRule.get(query.rule) ?? new Set<string>();
    emptyByRule.set(query.rule, empty);
    const ecsql = expandLists(query.ecsql, list.lists);
    if (query.onlyIfEmpty && !query.onlyIfEmpty.every((id) => empty.has(id))) {
      reports.push({ rule: query.rule, query: query.id, ecsql, ms: 0, rows: 0, skipped: true });
      results.push({ rule: query.rule, id: query.id, rows: [], count: 0, skipped: true, ms: 0 });
      continue;
    }
    const started = Date.now();
    let rows: unknown[][] = [];
    let error: string | undefined;
    try {
      rows = await readRows(runQuery, ecsql);
    } catch (caught) {
      error = (caught as Error).message;
    }
    const ms = Date.now() - started;
    reports.push({ rule: query.rule, query: query.id, ecsql, ms, rows: rows.length, error });
    const shown = rows.slice(0, query.max ?? 20);
    const result: StartupResult = {
      rule: query.rule, id: query.id, rows: shown, count: rows.length, ms,
      ...(rows.length >= ROW_GUARD ? { guarded: true } : {}), ...(error !== undefined ? { error } : {}),
    };
    if (isEmpty(rows)) {
      empty.add(query.id);
    } else if (query.each) {
      const each: (string | null)[] = [];
      for (const row of shown) {
        const eachSql = fillIdentifiers(query.each, row);
        if (!eachSql) {
          each.push(null);
          continue;
        }
        const eachStarted = Date.now();
        try {
          const found = await readRows(runQuery, eachSql);
          each.push(String(found[0]?.[0] ?? 0));
          reports.push({ rule: query.rule, query: `${query.id}/each`, ecsql: eachSql, ms: Date.now() - eachStarted, rows: found.length });
        } catch (caught) {
          each.push(null);
          reports.push({ rule: query.rule, query: `${query.id}/each`, ecsql: eachSql, ms: Date.now() - eachStarted, rows: 0, error: (caught as Error).message });
        }
      }
      result.each = each;
    }
    results.push(result);
  }
  return { results, reports };
}

/** The earlier name of `fetchTurns`. */
export const httpTurns = fetchTurns;
