/**
 * The one camera + microphone stream of an interview. The lobby check, the voice connection, and
 * the integrity monitor all read tracks from it; none of them calls getUserMedia or stops tracks.
 * A stream with an ended track is replaced on the next `acquire`, so a camera or microphone that
 * failed can be recovered without a page reload.
 */

export type MediaError = "denied" | "not_found" | "unsupported" | "failed";

export const INTERVIEW_MEDIA_CONSTRAINTS: MediaStreamConstraints = {
  video: true,
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

export interface MediaOwner {
  /** The current stream if every track is live; otherwise requests a new one. Concurrent calls share one request. */
  acquire(): Promise<MediaStream>;
  current(): MediaStream | null;
  /** Stops every track. A request still in flight is stopped when it resolves. */
  release(): void;
}

export class MediaAcquireError extends Error {
  constructor(readonly code: MediaError) {
    super(code);
  }
}

export function toMediaError(err: unknown): MediaError {
  if (err instanceof MediaAcquireError) {
    return err.code;
  }
  const name = err instanceof DOMException || err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "denied";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "not_found";
  }
  return "failed";
}

export function isStreamLive(stream: MediaStream): boolean {
  const tracks = stream.getTracks();
  return tracks.length > 0 && tracks.every((track) => track.readyState === "live");
}

export function createMediaOwner(
  getUserMedia: ((constraints: MediaStreamConstraints) => Promise<MediaStream>) | null,
  constraints: MediaStreamConstraints = INTERVIEW_MEDIA_CONSTRAINTS,
): MediaOwner {
  let stream: MediaStream | null = null;
  let pending: Promise<MediaStream> | null = null;
  let generation = 0;

  const stop = (s: MediaStream) => s.getTracks().forEach((track) => track.stop());

  return {
    acquire() {
      if (stream && isStreamLive(stream)) {
        return Promise.resolve(stream);
      }
      if (pending) {
        return pending;
      }
      if (!getUserMedia) {
        return Promise.reject(new MediaAcquireError("unsupported"));
      }
      if (stream) {
        stop(stream);
        stream = null;
      }
      const requested = generation;
      const request: Promise<MediaStream> = getUserMedia(constraints)
        .then((next) => {
          if (requested !== generation) {
            stop(next);
            throw new MediaAcquireError("failed");
          }
          stream = next;
          return next;
        })
        .finally(() => {
          if (pending === request) {
            pending = null;
          }
        });
      pending = request;
      return request;
    },
    current: () => stream,
    release() {
      generation++;
      pending = null;
      if (stream) {
        stop(stream);
        stream = null;
      }
    },
  };
}
