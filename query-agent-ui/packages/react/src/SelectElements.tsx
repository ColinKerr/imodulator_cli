/**
 * "Select N elements" under an answer: replaces the host's selection with the elements the answer
 * is about (`selection.ts`).
 */

import { useState } from "react";
import type { AgentClient, AgentRun } from "@query-agent/client";
import { plural, selectableOf, selectAnswerElements, selectedMessage, type SelectedElements, type SelectionTarget } from "./selection";

/** The host's unified selection, as the controls are given it (`AgentChatProps.selection`). */
export interface AnswerSelection {
  /** The store: a `SelectionStorage` from `@itwin/unified-selection` fits. */
  storage: SelectionTarget;
  /** The open iModel's key (`IModelConnection.key`). */
  imodelKey: string;
  /**
   * Replace the selection when an answer arrives, without a click: with every element the answer
   * names (its rows, when they carry `ECInstanceId` and `ClassName`). A selection request that found
   * nothing clears the selection.
   */
  autoSelect?: boolean;
  /** Called each time the agent replaced the selection: a host zooms to the elements here. */
  onSelected?: (result: SelectedElements, run: AgentRun) => void;
}

export function SelectElements(props: { run?: AgentRun; client: AgentClient; selection: AnswerSelection }): JSX.Element | null {
  const { run, client, selection } = props;
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const offered = selectableOf(run);
  if (!run || !offered)
    return null;

  const select = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await selectAnswerElements(run, client, selection.storage, selection.imodelKey);
      if (!result)
        return;
      setMessage(selectedMessage(result));
      selection.onSelected?.(result, run);
    } catch (err) {
      setMessage(`Could not select them: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" onClick={() => void select()} disabled={busy}>
        {offered.count === undefined ? "Select all the elements" : `Select ${plural(offered.count, "element")}`}
      </button>
      {message && <span className="qa-muted">{message}</span>}
    </>
  );
}
