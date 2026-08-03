/** Helpers shared by the `imod hub` commands. */

/** The `--itwin-id`/`--imodel-id`/`--url` options common to hub commands. */
export interface IModelTargetArgs {
  imodelId?: string;
  itwinId?: string;
  url?: string;
}

const GUID_REGEX = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

/**
 * Resolve the iTwin and iModel ids from either an explicit `--url` or the
 * `--itwin-id`/`--imodel-id` pair. When `--url` is supplied it takes precedence;
 * its first GUID is the iTwin id and its second is the iModel id.
 */
export function resolveCheckpointTarget(args: IModelTargetArgs): {
  itwinId: string;
  imodelId: string;
} {
  if (args.url) {
    const [itwinId, imodelId] = args.url.match(GUID_REGEX) ?? [];
    if (!itwinId || !imodelId)
      throw new Error(`--url must contain two GUIDs (iTwin id then iModel id): ${args.url}`);
    return { itwinId, imodelId };
  }
  if (!args.itwinId || !args.imodelId)
    throw new Error("Provide --url, or both --itwin-id and --imodel-id");
  return { itwinId: args.itwinId, imodelId: args.imodelId };
}
