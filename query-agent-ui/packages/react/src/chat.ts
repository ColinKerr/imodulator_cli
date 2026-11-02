import { earlierQuestion, type AgentRun, type EarlierQuestion } from "@query-agent/client";

/** One question and what came of it. */
export interface ChatTurn {
  question: string;
  /** The answer's text. Empty while the run is in progress. */
  answer: string;
  /** The answer's query, when it has one. */
  query?: string;
  /** How the run ended: "answered", "partial", "not_found", or why it stopped. */
  outcome?: string;
  /** Set when the run failed: what to tell the user. */
  error?: string;
  /** The whole run, for a host that keeps or shows more of it. Absent on a failed run. */
  run?: AgentRun;
}

/** A chat: its questions in order. The earlier questions and the last run's token give a follow-up its context. */
export interface Chat {
  turns: ChatTurn[];
}

/**
 * What a follow-up is sent of the chat so far: each earlier question as the user saw it, and the
 * token of the last finished run. A question that failed is left out.
 */
export async function contextOf(chat: Chat): Promise<{ earlier: EarlierQuestion[]; token?: string }> {
  const answered = chat.turns.filter((turn): turn is ChatTurn & { run: AgentRun } => turn.run !== undefined);
  const earlier = await Promise.all(answered.map((turn) => earlierQuestion(turn.question, turn.run)));
  const token = answered.at(-1)?.run.token;
  return { earlier, ...(token ? { token } : {}) };
}

/** The failure a user is shown. */
export const FAILED = "The agent could not finish.";
