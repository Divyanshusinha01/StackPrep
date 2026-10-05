/**
 * Display-only transcript built from Realtime data-channel events. One turn per conversation
 * item, kept in the order each item was first seen. The reducer persists nothing; finalized
 * turns are picked up by `newlyFinalTurns` and sent through the transcript outbox.
 */

export interface TranscriptTurn {
  itemId: string;
  text: string;
  final: boolean;
  /** The candidate barged in before the interviewer finished speaking. */
  interrupted: boolean;
}

export interface TranscriptState {
  ai: TranscriptTurn[];
  user: TranscriptTurn[];
}

export const EMPTY_TRANSCRIPT: TranscriptState = { ai: [], user: [] };

export interface RealtimeServerEvent {
  type: string;
  [key: string]: unknown;
}

type Pane = keyof TranscriptState;

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function upsert(
  state: TranscriptState,
  pane: Pane,
  itemId: string,
  update: (turn: TranscriptTurn) => TranscriptTurn,
): TranscriptState {
  const turns = state[pane];
  const index = turns.findIndex((t) => t.itemId === itemId);
  const current = index === -1 ? { itemId, text: "", final: false, interrupted: false } : turns[index];
  const next = update(current);
  const updated = index === -1 ? [...turns, next] : turns.map((t, i) => (i === index ? next : t));
  return { ...state, [pane]: updated };
}

function remove(state: TranscriptState, pane: Pane, itemId: string): TranscriptState {
  return { ...state, [pane]: state[pane].filter((t) => t.itemId !== itemId) };
}

function markInterrupted(state: TranscriptState, itemIds: string[]): TranscriptState {
  if (itemIds.length === 0) {
    return state;
  }
  const ids = new Set(itemIds);
  return {
    ...state,
    ai: state.ai.map((t) => (ids.has(t.itemId) ? { ...t, final: true, interrupted: true } : t)),
  };
}

/** Item ids of the response's output, from a `response.done` event. */
function responseItemIds(response: unknown): string[] {
  const output = (response as { output?: unknown } | null)?.output;
  return Array.isArray(output)
    ? output.map((item) => str((item as { id?: unknown } | null)?.id)).filter((id): id is string => id !== null)
    : [];
}

export function transcriptReducer(state: TranscriptState, event: RealtimeServerEvent): TranscriptState {
  const itemId = str(event.item_id);
  switch (event.type) {
    case "response.output_audio_transcript.delta": {
      const delta = str(event.delta);
      return itemId && delta ? upsert(state, "ai", itemId, (t) => ({ ...t, text: t.text + delta })) : state;
    }
    case "response.output_audio_transcript.done": {
      const transcript = str(event.transcript);
      return itemId
        ? upsert(state, "ai", itemId, (t) => ({ ...t, text: transcript ?? t.text, final: true }))
        : state;
    }
    case "input_audio_buffer.speech_started": {
      // Reserves the candidate's slot in speaking order; transcription can finish later.
      return itemId ? upsert(state, "user", itemId, (t) => t) : state;
    }
    case "conversation.item.input_audio_transcription.delta": {
      const delta = str(event.delta);
      return itemId && delta ? upsert(state, "user", itemId, (t) => ({ ...t, text: t.text + delta })) : state;
    }
    case "conversation.item.input_audio_transcription.completed": {
      if (!itemId) {
        return state;
      }
      const transcript = (str(event.transcript) ?? "").trim();
      return transcript
        ? upsert(state, "user", itemId, (t) => ({ ...t, text: transcript, final: true }))
        : remove(state, "user", itemId);
    }
    case "conversation.item.input_audio_transcription.failed": {
      if (!itemId) {
        return state;
      }
      const turn = state.user.find((t) => t.itemId === itemId);
      return turn?.text ? upsert(state, "user", itemId, (t) => ({ ...t, final: true })) : remove(state, "user", itemId);
    }
    case "output_audio_buffer.cleared": {
      // WebRTC: playback was cut off by barge-in.
      const last = state.ai.at(-1);
      return last ? markInterrupted(state, [last.itemId]) : state;
    }
    case "response.done": {
      const response = event.response as { status?: unknown } | null;
      return response?.status === "cancelled" ? markInterrupted(state, responseItemIds(response)) : state;
    }
    default:
      return state;
  }
}
