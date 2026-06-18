#!/usr/bin/env node
import * as dotenv from "dotenv";
import { runCli } from "./cli";
import { closeCacheDb } from "./cache/cache-db";
import { shutdownIModelHost } from "./host/imodel-host";

dotenv.config();

runCli()
  .then(async () => {
    await shutdownIModelHost();
    closeCacheDb();
  })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await shutdownIModelHost().catch(() => {});
    closeCacheDb();
    process.exitCode = 1;
  });
