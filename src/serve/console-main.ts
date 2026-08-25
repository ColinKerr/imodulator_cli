import { startConsoleServer } from "./console-server";

/**
 * Entry point for the detached console process.
 *
 * Started by `imod serve console`, never run directly.
 */
async function main(): Promise<void> {
  const portArg = process.env.IMOD_SERVE_PORT;
  const server = await startConsoleServer({
    port: portArg === undefined ? undefined : Number(portArg),
    imodelPath: process.env.IMOD_SERVE_IMODEL_PATH,
  });

  process.send?.({ ready: true, port: server.port, url: server.url });

  const shutdown = (): void => {
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.send?.({ ready: false, error: message });
  console.error(message);
  process.exit(1);
});
