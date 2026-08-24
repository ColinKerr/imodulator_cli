import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
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

const SERVERS: Record<ServerKind, ServerDefinition> = {
  backend: { entry: "backend-main.js", label: "backend server" },
  console: { entry: "console-main.js", label: "console" },
};

export interface ServerRecord {
  kind: ServerKind;
  pid: number;
  port: number;
  url: string;
  startedAt: string;
  logFile: string;
  defaultIModel?: { key: string; filePath: string };
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

  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ["ignore", log, log, "ipc"],
    env: {
      ...process.env,
      IMOD_SERVE_PORT: args.port === undefined ? undefined : String(args.port),
      ...args.env,
    },
  });

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
    };
    fs.writeFileSync(serverRecordPath(kind), JSON.stringify(record, null, 2));
    child.unref();
    child.disconnect();
    return record;
  } catch (err) {
    child.kill("SIGTERM");
    throw err;
  } finally {
    fs.closeSync(log);
  }
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
