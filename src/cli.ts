import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { authCommand } from "./commands/auth";
import { acquireIdCommand } from "./commands/hub/briefcase/acquire-id";
import { listIdCommand } from "./commands/hub/briefcase/list-id";
import { releaseIdCommand } from "./commands/hub/briefcase/release-id";
import { downloadBriefcaseCommand } from "./commands/hub/briefcase/download";
import { pushBriefcaseCommand } from "./commands/hub/briefcase/push";
import { downloadCheckpointCommand } from "./commands/hub/checkpoint/download";
import { cloneIModelCommand } from "./commands/hub/clone";
import { createIModelCommand } from "./commands/hub/create";
import { clearLocalCommand } from "./commands/local/clear";
import { cacheDirCommand } from "./commands/cache/dir";
import { cacheListImodelsCommand } from "./commands/cache/list-imodels";
import { cacheListDbCommand } from "./commands/cache/list-db";
import { importSchemasCommand } from "./commands/edit/import-schemas";
import { editPartinateCommand } from "./commands/edit/partinate";
import { editPokeCommand } from "./commands/edit/poke";
import { exportSchemasCommand } from "./commands/util/export-schemas";
import { mergeSchemaSetCommand } from "./commands/util/merge-schema-set";
import { partinateCommand } from "./commands/util/partinate";
import { queryCommand } from "./commands/util/query";
import { vacuumCommand } from "./commands/util/vacuum";

export async function runCli(argv: string[] = hideBin(process.argv)): Promise<void> {
  await yargs(argv)
    .scriptName("imod")
    .usage("$0 <command> [options]")
    .command(authCommand)
    .command({
      command: "hub <subcommand>",
      describe: "Access iModel Hub APIs",
      builder: (y) =>
        y
          .command(cloneIModelCommand)
          .command(createIModelCommand)
          .command({
            command: "briefcase <action>",
            describe: "Work with iModel briefcases",
            builder: (yy) =>
              yy
                .command(acquireIdCommand)
                .command(listIdCommand)
                .command(releaseIdCommand)
                .command(downloadBriefcaseCommand)
                .command(pushBriefcaseCommand)
                .demandCommand(1),
            handler: () => {},
          })
          .command({
            command: "checkpoint <action>",
            describe: "Work with iModel checkpoints",
            builder: (yy) => yy.command(downloadCheckpointCommand).demandCommand(1),
            handler: () => {},
          })
          .demandCommand(1),
      handler: () => {},
    })
    .command({
      command: "local <action>",
      describe: "Work with locally downloaded iModels",
      builder: (y) => y.command(clearLocalCommand).demandCommand(1),
      handler: () => {},
    })
    .command({
      command: "serve <action>",
      describe: "Run local servers",
      handler: () => {},
    })
    .command({
      command: "edit <action>",
      describe: "Edit iModels, creating local change sets that can be pushed to the hub",
      builder: (y) =>
        y
          .command(importSchemasCommand)
          .command(editPartinateCommand)
          .command(editPokeCommand)
          .demandCommand(1),
      handler: () => {},
    })
    .command({
      command: "cache <action>",
      describe: "Control and view cached data",
      builder: (y) =>
        y
          .command(cacheDirCommand)
          .command(cacheListImodelsCommand)
          .command(cacheListDbCommand)
          .demandCommand(1),
      handler: () => {},
    })
    .command({
      command: "util <action>",
      describe: "Utility commands",
      builder: (y) =>
        y
          .command(exportSchemasCommand)
          .command(mergeSchemaSetCommand)
          .command(partinateCommand)
          .command(queryCommand)
          .command(vacuumCommand)
          .demandCommand(1),
      handler: () => {},
    })
    .demandCommand(1)
    .strict()
    .help()
    .alias("h", "help")
    .alias("v", "version")
    .parseAsync();
}
