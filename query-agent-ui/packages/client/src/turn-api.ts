/**
 * The turn API's types: everything that travels between the client and the function, and nothing
 * else.
 */

export interface ResultCaps {
  /** How many rows may be shown. */
  maxRows: number;
  /** How many characters of formatted rows may be shown, across all of them. */
  maxChars: number;
  /** How long a single value may be before it is clipped. */
  maxCellChars: number;
}

/**
 * One query's result as the client sends it: the rows it read, up to the caps the function sent,
 * or the query's error.
 *
 * The client stops where the function's format would stop, so it never reads or sends more than
 * the model can be shown. A string longer than `maxCellChars` travels cut to that length, with
 * its full length in `clipped`, so the function can say how much was cut.
 */
export interface QueryRows {
  /** The query exactly as the response asked for it. */
  ecsql: string;
  columns?: string[];
  rows?: unknown[][];
  /** The cells cut to `maxCellChars`: row index, column index, full length. */
  clipped?: [number, number, number][];
  /** Which cap stopped the read, if either did. */
  truncatedBy?: "rows" | "chars";
  /** The query's error message, when it failed (at the start or part way through the rows). */
  error?: string;
  /** How long the client took to run and read it. */
  ms: number;
}

/**
 * One startup query's result as the client sends it: the rows to show, how many rows there were,
 * and the value of the `each` query for each row shown.
 */
export interface StartupResult {
  rule: string;
  id: string;
  /** The rows to show: at most the query's `max`. */
  rows: unknown[][];
  /** How many rows the query returned, counted up to the client's guard. */
  count: number;
  /** True when the count stopped at the guard, so there may be more. */
  guarded?: boolean;
  /** For each row shown, its `each` value: a count, or null when it could not be run. */
  each?: (string | null)[];
  /** Not run, because a query it depends on was not empty. */
  skipped?: boolean;
  /** The query failed (the class or schema is not in this file). It is then empty. */
  error?: string;
  ms: number;
}

export type StopReason = "answered" | "stuck" | "steps" | "aborted";

/**
 * How much of an answer's rows an earlier question keeps for the questions after it. Smaller than a
 * live result: enough for a count, a short list, or the top of a long one.
 */
export const HISTORY_CAPS: ResultCaps = { maxRows: 20, maxChars: 2_000, maxCellChars: 200 };

/** An earlier question of the chat, as the user saw it. */
export interface EarlierQuestion {
  question: string;
  answer: string;
  query?: string;
  /** The answer's query's rows, cut to `HISTORY_CAPS`, or its error. */
  rows?: Pick<QueryRows, "columns" | "rows" | "clipped" | "truncatedBy" | "error">;
  stoppedBecause: StopReason;
}

export interface SubmittedAnswer {
  explanation: string;
  query: string;
  outcome: "answered" | "partial" | "not_found";
  rowLimitIntended: boolean;
}

/**
 * How the answer is to be given, for a host with unified selection. Absent, or any other value, is
 * the plain answer.
 *
 * - `auto`: the host selects elements from answers. The agent decides, question by question,
 *   whether the question asks to select elements. An answer whose rows are elements also returns
 *   their `ECInstanceId` and `ClassName`.
 * - `select`: a host preference (the user set the app to select): every question is a request to
 *   select elements, and the answer's `query` is the selection. A host sets it from the user's
 *   choice, never from scanning the question.
 */
export type AnswerMode = "auto" | "select";

/** The answer modes, for checking a request's. */
export const ANSWER_MODES: readonly AnswerMode[] = ["auto", "select"];

/**
 * What a finished answer is, in the `auto` and `select` modes (`TurnDone.resultType`). It tells
 * the host what to do with the answer, not how the agent made it.
 *
 * - `selection`: the answer's `query` is the selection. Select its rows (`ECInstanceId`,
 *   `ClassName`); no rows, or `not_found`, clears the selection.
 * - `answer`: an answer to show. Select its rows only when they have both key columns.
 */
export type ResultType = "selection" | "answer";

/** What the client sends for one turn: `POST /turn`. */
export interface TurnRequest {
  question: string;
  /** Whether the client has an iModel to query. Without one, `runQuery` is not offered. */
  canQuery: boolean;
  /** The open iModel: its name, and the rows of the startup query list, sent with every turn. */
  imodel?: { name: string; startup?: StartupResult[] };
  /** What is in the query editor, which is context for "fix this" and "what does this do". */
  editorText?: string;
  /** The chat's earlier questions, oldest first, as the user saw them. The same in every turn of a run. */
  earlier?: EarlierQuestion[];
  /**
   * The token from the last response: of this run, or, on a run's first turn, of the chat's last
   * finished run. Absent on a chat's first turn. Opaque: the client stores it and sends it back.
   */
  token?: string;
  /** The rows, or the error, of each query the last response asked for. */
  results?: QueryRows[];
  /** The user stopped the run.*/
  aborted?: boolean;
  /** How the answer is to be given (`AnswerMode`). Sent with every turn of a run, the same each time. */
  answerMode?: AnswerMode;
}

/** What the run ends with: the answer, as the user sees it. */
export interface TurnDone {
  /** The final prose answer, which should carry exactly one fenced sql block. */
  answer: string;
  /** The query pulled out of the answer, if there was one. */
  query?: string;
  /** The answer as submitted, when the run ended that way. */
  structured?: SubmittedAnswer;
  stoppedBecause: StopReason;
  /** Names the run's record, where the function keeps one. */
  runId: string;
  /** In the `auto` and `select` modes: what the answer is (`ResultType`). */
  resultType?: ResultType;
}

/** What the function sends back for one turn. */
export interface TurnResponse {
  /** The token to send with the next turn: of this run, or, after `done`, of the chat's next question. */
  token: string;
  /** The queries to run before the next turn. When there are none, the client sends the next turn at once. */
  queries: string[];
  /** How much of each query's result to read. */
  caps: ResultCaps;
  /** Present when the run is over. */
  done?: TurnDone;
}
