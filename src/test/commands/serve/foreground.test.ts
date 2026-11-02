import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  adoptForeground, echoServerOutput, foregroundRequested, holdForeground, serverRecordPath, stopForeground, type ServerKind,
} from "../../../serve/server-process";
import { testCacheDir, testTempDir } from "../../temp-workspace";

let children: ChildProcess[] = [];

beforeAll(() => {
  testCacheDir();
});

afterEach(() => {
  for (const child of children)
    child.kill("SIGKILL");
  children = [];
  delete process.env.IMOD_SERVE_FOREGROUND;
});

/** A stand-in server, run from source with piped output, as a foreground server is. */
function child(source: string): ChildProcess {
  const started = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(started);
  return started;
}

function record(kind: ServerKind, pid: number): void {
  writeFileSync(serverRecordPath(kind), JSON.stringify({ kind, pid, port: 1, url: "http://127.0.0.1:1", startedAt: "", logFile: "unused" }));
}

const text = (stream: PassThrough): string => (stream.read() as Buffer | null)?.toString() ?? "";

describe("imod serve --foreground", () => {
  it("is asked for by the option, or by IMOD_SERVE_FOREGROUND=1", () => {
    expect(foregroundRequested(undefined)).toBe(false);
    expect(foregroundRequested(true)).toBe(true);
    process.env.IMOD_SERVE_FOREGROUND = "1";
    expect(foregroundRequested(undefined)).toBe(true);
  });

  it("prints each line of a server's output with its name, and still writes the log file", async () => {
    const logFile = join(testTempDir("foreground-log"), "serve-backend.log");
    const server = child(`console.log("listening"); console.error("query agent not set up");`);
    const out = new PassThrough();
    const err = new PassThrough();
    echoServerOutput("backend", server, openSync(logFile, "a"), out, err);
    await new Promise((resolve) => server.once("close", resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(text(out)).toBe("[backend] listening\n");
    expect(text(err)).toBe("[backend] query agent not set up\n");
    expect(readFileSync(logFile, "utf8")).toContain("listening\n");
    expect(readFileSync(logFile, "utf8")).toContain("query agent not set up\n");
  });

  it("stops every server it started, as Ctrl+C does, and clears their records", async () => {
    const backend = child("setInterval(() => {}, 1000);");
    const consoleServer = child("setInterval(() => {}, 1000);");
    record("backend", backend.pid!);
    record("console", consoleServer.pid!);
    adoptForeground("backend", backend);
    adoptForeground("console", consoleServer);

    const held = holdForeground();
    stopForeground();
    await held;

    expect(backend.signalCode).toBe("SIGTERM");
    expect(consoleServer.signalCode).toBe("SIGTERM");
    expect(existsSync(serverRecordPath("backend"))).toBe(false);
    expect(existsSync(serverRecordPath("console"))).toBe(false);
  });

  it("stops the others when one server stops by itself", async () => {
    const backend = child("setTimeout(() => process.exit(3), 100);");
    const consoleServer = child("setInterval(() => {}, 1000);");
    adoptForeground("backend", backend);
    adoptForeground("console", consoleServer);

    await holdForeground();

    expect(backend.exitCode).toBe(3);
    expect(consoleServer.signalCode).toBe("SIGTERM");
  });
});
