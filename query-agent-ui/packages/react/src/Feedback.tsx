/**
 * The feedback form under an answer. The user rates the answer, may correct its text or its query,
 * may add a comment, then sees exactly what would be sent and chooses to send it. It holds only
 * what the user saw and wrote: the question, the answer, the query, and the user's own text.
 * Nothing is uploaded by the control: the host gets the feedback (`onFeedback`) and decides.
 */

import { useState } from "react";
import type { ChatTurn } from "./chat";

export type Rating = "right" | "partly" | "wrong";

/** What is sent: everything here was shown to, or written by, the user. */
export interface Feedback {
  question: string;
  answer: string;
  query?: string;
  rating: Rating;
  correctedAnswer?: string;
  correctedQuery?: string;
  comment?: string;
}

/** The feedback for a turn, with empty text left out. */
export function feedbackOf(turn: ChatTurn, rating: Rating, edits: { correctedAnswer?: string; correctedQuery?: string; comment?: string }): Feedback {
  const text = (value: string | undefined): string | undefined => (value && value.trim().length > 0 ? value.trim() : undefined);
  const correctedAnswer = text(edits.correctedAnswer);
  const correctedQuery = text(edits.correctedQuery);
  const comment = text(edits.comment);
  return {
    question: turn.question,
    answer: turn.answer,
    ...(turn.query ? { query: turn.query } : {}),
    rating,
    ...(correctedAnswer && correctedAnswer !== turn.answer.trim() ? { correctedAnswer } : {}),
    ...(correctedQuery && correctedQuery !== turn.query?.trim() ? { correctedQuery } : {}),
    ...(comment ? { comment } : {}),
  };
}

const RATINGS: { value: Rating; label: string }[] = [
  { value: "right", label: "Right" },
  { value: "partly", label: "Partly right" },
  { value: "wrong", label: "Wrong" },
];

export function FeedbackForm(props: { turn: ChatTurn; onFeedback: (feedback: Feedback) => void | Promise<void> }): JSX.Element {
  const { turn } = props;
  const [rating, setRating] = useState<Rating | undefined>();
  const [correctedAnswer, setCorrectedAnswer] = useState(turn.answer);
  const [correctedQuery, setCorrectedQuery] = useState(turn.query ?? "");
  const [comment, setComment] = useState("");
  const [stage, setStage] = useState<"rate" | "review" | "sent">("rate");

  if (stage === "sent")
    return <div className="qa-feedback qa-feedback-sent">Thank you. Your feedback was sent.</div>;

  if (!rating) {
    return (
      <div className="qa-feedback" role="group" aria-label="Rate this answer">
        <span>Was this answer right?</span>
        {RATINGS.map((option) => (
          <button type="button" key={option.value} onClick={() => setRating(option.value)}>{option.label}</button>
        ))}
      </div>
    );
  }

  const feedback = feedbackOf(turn, rating, { correctedAnswer, correctedQuery, comment });
  if (stage === "review") {
    return (
      <div className="qa-feedback">
        <div>This is exactly what will be sent:</div>
        <pre className="qa-feedback-preview">{JSON.stringify(feedback, null, 2)}</pre>
        <button type="button" onClick={() => setStage("rate")}>Edit</button>
        <button type="button" onClick={() => void Promise.resolve(props.onFeedback(feedback)).then(() => setStage("sent"))}>Send</button>
        <button type="button" onClick={() => setRating(undefined)}>Cancel</button>
      </div>
    );
  }

  return (
    <div className="qa-feedback">
      <div>Rated: {RATINGS.find((option) => option.value === rating)?.label}. You can correct the answer or the query, and add a comment.</div>
      <label>The right answer<textarea value={correctedAnswer} onChange={(event) => setCorrectedAnswer(event.target.value)} rows={3} /></label>
      {turn.query !== undefined && (
        <label>The right query<textarea value={correctedQuery} onChange={(event) => setCorrectedQuery(event.target.value)} rows={4} /></label>
      )}
      <label>Comment<textarea value={comment} onChange={(event) => setComment(event.target.value)} rows={2} /></label>
      <button type="button" onClick={() => setStage("review")}>Review what will be sent</button>
      <button type="button" onClick={() => setRating(undefined)}>Cancel</button>
    </div>
  );
}
