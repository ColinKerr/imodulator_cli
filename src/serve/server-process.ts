import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { ensureCacheDir } from "../cache/cache-dir";

/** How long to wait for a server process to report that it is listening. */
const READY_TIMEOUT_MS = 60_000;

/** The servers `imod serve` can run. Each keeps its own record, log and process. */
export type ServerKind = "backend" | "console";

interface ServerDefinition {
  /** Module under dist/serve that runs the server. */
  entry: string;
  /** Human readable name for messages. */
  label: string;
}

/**
 * Declared dependents first: the console queries the backend, so stopping everything works
 * through this in order and never leaves a live console pointing at a stopped backend.
 */
const SERVERS: Record<ServerKind, ServerDefinition> = {
  console: { entry: "console-main.js", label: "console" },
  backend: { entry: "backend-main.js", label: "backend server" },
};

/**
 * Every kind of server, derived rather than listed, so a new one cannot be added without
 * `imod serve stop-all` picking it up.
 */
export const SERVER_KINDS = Object.keys(SERVERS) as ServerKind[];

/** The name used for a server in messages. */
export function serverLabel(kind: ServerKind): string {
  return SERVERS[kind].label;
}

export interface ServerRecord {
  kind: ServerKind;
  pid: number;
  port: number;
  url: string;
  startedAt: string;
  logFile: string;
  defaultIModel?: { key: string; filePath: string };
  /**
   * The server that started this one, when it was not started on its own account.
   *
   * `imod serve console` starts a backend if none is running, and stopping the console then
   * stops that backend too -- but only this one, never a backend the user started themselves.
   */
  startedBy?: ServerKind;
}

export function serverRecordPath(kind: ServerKind): string {
  return path.join(ensureCacheDir(), `serve-${kind}.json`);
}

export function serverLogPath(kind: ServerKind): string {
  return path.join(ensureCacheDir(), `serve-${kind}.log`);
}

export function readServerRecord(kind: ServerKind): ServerRecord | undefined {
  const file = serverRecordPath(kind);
  if (!fs.existsSync(file))
    return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as ServerRecord;
  } catch {
    return undefined;
  }
}

function clearServerRecord(kind: ServerKind): void {
  fs.rmSync(serverRecordPath(kind), { force: true });
}

/** Whether a process with this id exists. Signal 0 tests for the process without signalling it. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Confirm the recorded process is still the server, not a recycled process id.
 *
 * A stale record whose pid has been handed to something else would otherwise make `--stop`
 * kill an unrelated process. The port is what proves identity: only our server answers
 * `/health` on it.
 */
export async function isServerAlive(record: ServerRecord): Promise<boolean> {
  if (!isRunning(record.pid))
    return false;
  try {
    const response = await fetch(`${record.url}/health`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok)
      return false;
    const body = (await response.json()) as { server?: string };
    return body.server === record.kind;
  } catch {
    return false;
  }
}

/** The running server of this kind, or undefined when none is running. */
export async function findRunningServer(kind: ServerKind): Promise<ServerRecord | undefined> {
  const record = readServerRecord(kind);
  if (!record)
    return undefined;
  return (await isServerAlive(record)) ? record : undefined;
}

export interface StartServerArgs {
  port?: number;
  /** Passed to the server process as IMOD_SERVE_* environment variables. */
  env?: Record<string, string | undefined>;
  /** Recorded when another server is starting this one on its behalf. */
  startedBy?: ServerKind;
  /**
   * Keep the server attached to this process: its output prints in this terminal, each line
   * prefixed with the server's kind, and still goes to its log file. See `holdForeground`.
   */
  foreground?: boolean;
}

/** `--foreground`, or `IMOD_SERVE_FOREGROUND=1` for a developer who wants it every time. */
export function foregroundRequested(flag: boolean | undefined): boolean {
  return flag === true || process.env.IMOD_SERVE_FOREGROUND === "1";
}

/** The processes this process started in the foreground, which it stops when it is stopped, and what to clear when each ends. */
const foregroundChildren = new Map<ServerKind, { child: ChildProcess; ended: () => void; stop: () => void }>();

/**
 * Copy each line a server prints to its log file, and to this terminal with the server's kind
 * first. The log file is closed when the server's output ends.
 */
export function echoServerOutput(
  kind: ServerKind, child: ChildProcess, log: number,
  out: NodeJS.WritableStream = process.stdout, err: NodeJS.WritableStream = process.stderr,
): void {
  for (const [stream, to] of [[child.stdout, out], [child.stderr, err]] as const) {
    if (stream)
      readline.createInterface({ input: stream }).on("line", (line) => {
        fs.writeSync(log, `${line}\n`);
        to.write(`[${kind}] ${line}\n`);
      });
  }
  child.once("close", () => fs.closeSync(log));
}

/**
 * Record a process started in the foreground, so `holdForeground` waits for it and stops it.
 * `ended` runs when it stops; for a server, it clears the server's record.
 */
export function adoptForeground(
  name: ServerKind, child: ChildProcess,
  ended: () => void = () => clearServerRecord(name), stop: () => void = () => child.kill("SIGTERM"),
): void {
  foregroundChildren.set(name, { child, ended, stop });
}

/**
 * Spawn a server in its own process and return once it is listening.
 *
 * Detached with its own IPC channel: the channel carries the readiness report, and the
 * parent unrefs it afterwards so the CLI can exit while the server keeps running.
 */
export async function startServerProcess(kind: ServerKind, args: StartServerArgs): Promise<ServerRecord> {
  const definition = SERVERS[kind];
  const existing = await findRunningServer(kind);
  if (existing)
    throw new Error(
      `The ${definition.label} is already running at ${existing.url} (pid ${existing.pid}). Stop it with: imod serve ${kind} --stop`,
    );

  const logFile = serverLogPath(kind);
  const log = fs.openSync(logFile, "a");
  const entry = path.join(__dirname, definition.entry);
  if (!fs.existsSync(entry))
    throw new Error(`Server entry point not found: ${entry}. Build the CLI first.`);

  const foreground = args.foreground === true;
  const child = spawn(process.execPath, [entry], {
    // In the foreground, Ctrl+C reaches the server with this process, and its output is echoed.
    detached: !foreground,
    stdio: foreground ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", log, log, "ipc"],
    env: {
      ...process.env,
      IMOD_SERVE_PORT: args.port === undefined ? undefined : String(args.port),
      ...args.env,
    },
  });
  if (foreground)
    echoServerOutput(kind, child, log);

  try {
    const ready = await waitForReady(child, logFile);
    const record: ServerRecord = {
      kind,
      pid: child.pid!,
      port: ready.port,
      url: ready.url,
      startedAt: new Date().toISOString(),
      logFile,
      defaultIModel: ready.defaultIModel,
      startedBy: args.startedBy,
    };
    fs.writeFileSync(serverRecordPath(kind), JSON.stringify(record, null, 2));
    child.disconnect();
    if (foreground) {
      // The log stays open while the output is echoed into it, and closes when the server exits.
      adoptForeground(kind, child);
    } else {
      child.unref();
      fs.closeSync(log);
    }
    return record;
  } catch (err) {
    child.kill("SIGTERM");
    if (!foreground)
      fs.closeSync(log);
    throw err;
  }
}

/**
 * Wait while the servers this process started in the foreground run. Ctrl+C (or SIGTERM) stops
 * them all; if one stops by itself, the others are stopped too. Resolves once all have stopped,
 * with their records cleared.
 */
export async function holdForeground(): Promise<void> {
  const children = [...foregroundChildren.entries()];
  if (children.length === 0)
    return;
  let stopping = false;
  const stopAll = (): void => {
    if (stopping)
      return;
    stopping = true;
    stopForeground();
  };
  process.once("SIGINT", stopAll);
  process.once("SIGTERM", stopAll);
  await Promise.all(children.map(([name, { child, ended }]) => new Promise<void>((resolve) => {
    const done = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (!stopping)
        console.log(`The ${serverLabel(name)} stopped (${signal ?? `exit code ${code}`}); stopping the others.`);
      ended();
      foregroundChildren.delete(name);
      stopAll();
      resolve();
    };
    if (child.exitCode !== null || child.signalCode !== null)
      done(child.exitCode, child.signalCode);
    else
      child.once("exit", done);
  })));
  process.off("SIGINT", stopAll);
  process.off("SIGTERM", stopAll);
}

/** Stop every server this process started in the foreground: what Ctrl+C does. */
export function stopForeground(): void {
  for (const { child, stop } of foregroundChildren.values())
    if (child.exitCode === null && child.signalCode === null)
      stop();
}

interface ReadyMessage {
  ready: boolean;
  port: number;
  url: string;
  error?: string;
  defaultIModel?: { key: string; filePath: string };
}

function waitForReady(child: ReturnType<typeof spawn>, logFile: string): Promise<ReadyMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`The server did not start within ${READY_TIMEOUT_MS / 1000}s. See ${logFile}.`));
    }, READY_TIMEOUT_MS);

    const settle = (fn: () => void): void => {
      clearTimeout(timer);
      fn();
    };

    child.on("message", (message) => {
      const ready = message as ReadyMessage;
      if (ready.ready)
        settle(() => resolve(ready));
      else
        settle(() => reject(new Error(ready.error ?? "The server failed to start.")));
    });
    child.on("error", (err) => settle(() => reject(err)));
    child.on("exit", (code) =>
      settle(() => reject(new Error(`The server exited with code ${code} before it was ready. See ${logFile}.`))));
  });
}

export interface StopResult {
  stopped: boolean;
  /** Set when there was a record but it did not describe a running server. */
  staleRecord?: boolean;
  record?: ServerRecord;
}

/** Stop the running server of this kind, if the recorded process really is one. */
export async function stopServerProcess(kind: ServerKind): Promise<StopResult> {
  const record = readServerRecord(kind);
  if (!record)
    return { stopped: false };

  if (!(await isServerAlive(record))) {
    clearServerRecord(kind);
    return { stopped: false, staleRecord: true, record };
  }

  process.kill(record.pid, "SIGTERM");
  for (let waited = 0; waited < 10_000 && isRunning(record.pid); waited += 200)
    await new Promise((resolve) => setTimeout(resolve, 200));

  clearServerRecord(kind);
  return { stopped: true, record };
}
