/**
 * The client a host starts for an open iModel: it runs the startup list when it starts, then
 * answers questions by driving turns with the function.
 *
 * ```ts
 * const client = AgentClient.start({ runQuery: queryRunner(imodel), imodelName, functionUrl });
 * const run = await client.ask("How many pipes are there?", { onStatus });
 * ```
 */

import { readCapped, type RunRawQuery } from "./caps";
import { driveTurns, fetchTurns, runStartupQueries, type AgentRun, type AnswerRows, type ClientOptions, type StartupList, type TurnCall } from "./client";
import { instanceKeys, readSelection, type InstanceKey, type RunSelection } from "./selection";
import { ResultPages } from "./result-pages";
import defaultList from "./startup-queries.json";
import type { AnswerMode, EarlierQuestion, QueryRows, ResultCaps, StartupResult } from "./turn-api";

/** The library's startup query list (`startup-queries.json`): what a client runs when it starts. */
export const DEFAULT_STARTUP_LIST = defaultList as StartupList;

/** What the client is doing: what a host shows while it waits. */
export type AgentStatus =
  | { phase: "exploring" }
  | { phase: "thinking" }
  | { phase: "querying"; ecsql: string };

/** How much of an answer's rows the client reads for the host to show. */
export const ANSWER_CAPS: ResultCaps = { maxRows: 200, maxChars: 200_000, maxCellChars: 400 };

/**
 * An answer's query's rows, read once with `ANSWER_CAPS`, or the error it gave; undefined when
 * there is no query. What `AgentClient.ask` keeps on the run, for the host and for later questions.
 */
export async function readAnswerRows(runQuery: RunRawQuery, query: string | undefined): Promise<AnswerRows | undefined> {
  if (!query)
    return undefined;
  try {
    return await readCapped(await runQuery(query), ANSWER_CAPS);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export interface AgentClientOptions {
  /** How to run a query on the iModel: `queryRunner(imodel)`. Absent for questions about ECSql alone. */
  runQuery?: RunRawQuery;
  /** The iModel's name, as the agent is told it. */
  imodelName?: string;
  /** The function's base URL; `POST <url>/turn` is called. */
  functionUrl?: string;
  /** In place of `functionUrl`: how to send one turn (a test, or the function in the same process). */
  turns?: TurnCall;
  /** The user's access key for the function, sent with every turn (`FetchTurnsOptions.getAccessToken`). */
  getAccessToken?: () => Promise<string | undefined>;
  /** The startup query list. The library's own list by default. */
  startupList?: StartupList;
  /** Called when the startup list starts and ends. */
  onExploring?: (exploring: boolean) => void;
  /**
   * How answers are to be given, for a host with unified selection (the turn API's `AnswerMode`):
   *
   * - `auto`: the host selects elements from answers. The agent decides, question by question,
   *   whether a question asks to select; `AgentRun.resultType` says what each answer is.
   * - `select`: the user's preference that every question is a selection request.
   *
   * Set from the host's settings, never from the question: the client does not scan questions.
   */
  answerMode?: AnswerMode;
}

export interface AskOptions {
  /** The text in the host's query editor, if any. */
  editorText?: string;
  /** The chat's earlier questions (`earlierQuestion`), so a follow-up has their context. */
  earlier?: readonly EarlierQuestion[];
  /** The token of the chat's last finished run (`AgentRun.token`). Opaque: kept and sent back, never read. */
  token?: string;
  /** This question's answer mode, in place of the client's (`AgentClientOptions.answerMode`). */
  answerMode?: AnswerMode;
  onStatus?: (status: AgentStatus) => void;
  signal?: AbortSignal;
}

export class AgentClient {
  private readonly turns: TurnCall;
  private explored = false;
  /** The startup list's rows: undefined when there is no iModel, or when the list could not run. */
  public readonly startup: Promise<StartupResult[] | undefined>;

  private constructor(private readonly options: AgentClientOptions) {
    if (options.turns)
      this.turns = options.turns;
    else if (options.functionUrl)
      this.turns = fetchTurns(options.functionUrl, { getAccessToken: options.getAccessToken });
    else
      throw new Error("AgentClient needs functionUrl, or turns.");
    this.startup = this.explore();
  }

  /** Start the client: the startup list begins to run at once (see `startup`). */
  public static start(options: AgentClientOptions): AgentClient {
    return new AgentClient(options);
  }

  private async explore(): Promise<StartupResult[] | undefined> {
    const { runQuery } = this.options;
    if (!runQuery)
      return undefined;
    this.options.onExploring?.(true);
    try {
      // A list that cannot run leaves the block out, and the agent works without it.
      return (await runStartupQueries(this.options.startupList ?? DEFAULT_STARTUP_LIST, runQuery)).results;
    } catch {
      return undefined;
    } finally {
      this.explored = true;
      this.options.onExploring?.(false);
    }
  }

  /**
   * Read a query's rows on the iModel, up to the caps given: for a host that shows an answer's
   * results. Throws when there is no iModel, or the query fails.
   */
  public async read(ecsql: string, caps: ResultCaps = ANSWER_CAPS): Promise<Pick<QueryRows, "columns" | "rows" | "clipped" | "truncatedBy">> {
    if (!this.options.runQuery)
      throw new Error("No iModel is open.");
    return readCapped(await this.options.runQuery(ecsql), caps);
  }

  /** Answer one question. While the startup list still runs, it waits for it, with the status `exploring`. */
  public async ask(question: string, options: AskOptions = {}): Promise<AgentRun> {
    const { runQuery, imodelName } = this.options;
    if (!this.explored && this.options.runQuery)
      options.onStatus?.({ phase: "exploring" });
    const startup = await this.startup;
    // The host's choice of mode. The agent decides what each question gets; the client never scans it.
    const answerMode: AnswerMode | undefined = options.answerMode ?? this.options.answerMode;
    const client: ClientOptions = {
      runQuery,
      imodel: imodelName !== undefined ? { name: imodelName, startup } : undefined,
      editorText: options.editorText,
      earlier: options.earlier,
      token: options.token,
      answerMode,
      onPhase: (phase, ecsql) => options.onStatus?.(phase === "querying" ? { phase, ecsql: ecsql ?? "" } : { phase }),
      signal: options.signal,
    };
    const run = await driveTurns(question, client, this.turns);
    const query = run.structured?.query || run.query;
    const answerRows = await this.answerRows(query);
    // All the rows, for a table: paged by the query reader, starting from the rows already read.
    const results = query && runQuery && answerRows && answerRows.error === undefined
      ? new ResultPages(runQuery, query, { columns: answerRows.columns ?? [], rows: answerRows.rows ?? [], complete: answerRows.truncatedBy === undefined && !answerRows.clipped })
      : undefined;
    return { ...run, ...(answerMode ? { answerMode } : {}), ...(answerRows ? { answerRows } : {}), ...(results ? { results } : {}) };
  }

  /**
   * The elements a query returns, read in full (its `ECInstanceId` or `id` column, and `ClassName`),
   * handed to `onKeys` in chunks as they are read: for selecting all the elements of an answer.
   * Never throws: a failure is the
   * selection's `error`, as when there is no iModel.
   */
  public async readSelection(ecsql: string, onKeys?: (keys: InstanceKey[]) => void | Promise<void>, signal?: AbortSignal): Promise<RunSelection> {
    if (!this.options.runQuery)
      return { error: "No iModel is open." };
    return readSelection(this.options.runQuery, ecsql, onKeys, signal);
  }

  /**
   * The instance keys of ids, for selecting them: each element once with its class, read in
   * batches, and how many of the ids were not elements. Throws when there is no iModel.
   */
  public async instanceKeys(ids: readonly string[]): Promise<{ keys: InstanceKey[]; notElements: number }> {
    if (!this.options.runQuery)
      throw new Error("No iModel is open.");
    return instanceKeys(this.options.runQuery, ids);
  }

  /**
   * The answer's query's rows, read once when the run ends: the host shows them, and a later
   * question of the chat sends the first of them (`earlierQuestion`).
   */
  private async answerRows(query: string | undefined): Promise<AnswerRows | undefined> {
    return this.options.runQuery ? readAnswerRows(this.options.runQuery, query) : undefined;
  }
}
