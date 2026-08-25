import { startBackendServer } from "./backend-server";

/**
 * Entry point for the detached server process.
 *
 * Started by `imod serve backend`, never run directly. Once listening it reports back over
 * the IPC channel so the parent can print the details and exit while this process keeps
 * running.
 */
async function main(): Promise<void> {
  const portArg = process.env.IMOD_SERVE_PORT;
  const server = await startBackendServer({
    port: portArg === undefined ? undefined : Number(portArg),
    imodelPath: process.env.IMOD_SERVE_IMODEL_PATH,
  });

  process.send?.({
    ready: true,
    port: server.port,
    url: server.url,
    defaultIModel: server.defaultIModel,
  });

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
