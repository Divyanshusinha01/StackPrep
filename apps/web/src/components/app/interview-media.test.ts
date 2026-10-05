import { describe, expect, it, vi } from "vitest";
import { createMediaOwner, isStreamLive, MediaAcquireError, toMediaError } from "./interview-media";

interface FakeTrack {
  readyState: "live" | "ended";
  stop: ReturnType<typeof vi.fn>;
}

function fakeStream() {
  const tracks: FakeTrack[] = [0, 1].map(() => {
    const track: FakeTrack = { readyState: "live", stop: vi.fn(() => (track.readyState = "ended")) };
    return track;
  });
  return { stream: { getTracks: () => tracks } as unknown as MediaStream, tracks };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

describe("createMediaOwner", () => {
  it("shares one getUserMedia request between concurrent callers", async () => {
    const { stream } = fakeStream();
    const request = deferred<MediaStream>();
    const getUserMedia = vi.fn(() => request.promise);
    const owner = createMediaOwner(getUserMedia);
    const lobby = owner.acquire();
    const voice = owner.acquire();
    request.resolve(stream);
    await expect(lobby).resolves.toBe(stream);
    await expect(voice).resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("reuses a live stream without asking again", async () => {
    const { stream } = fakeStream();
    const getUserMedia = vi.fn(async () => stream);
    const owner = createMediaOwner(getUserMedia);
    await owner.acquire();
    await expect(owner.acquire()).resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(owner.current()).toBe(stream);
  });

  it("replaces a stream with an ended track exactly once", async () => {
    const first = fakeStream();
    const second = fakeStream();
    const getUserMedia = vi.fn().mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);
    const owner = createMediaOwner(getUserMedia);
    await owner.acquire();
    first.tracks[0].readyState = "ended";

    const [a, b] = await Promise.all([owner.acquire(), owner.acquire()]);
    expect(a).toBe(second.stream);
    expect(b).toBe(second.stream);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(first.tracks[1].stop).toHaveBeenCalled();
  });

  it("stops a stream that arrives after release and lets the next acquire start fresh", async () => {
    const late = fakeStream();
    const fresh = fakeStream();
    const request = deferred<MediaStream>();
    const getUserMedia = vi.fn().mockReturnValueOnce(request.promise).mockResolvedValueOnce(fresh.stream);
    const owner = createMediaOwner(getUserMedia);
    const stale = owner.acquire();
    owner.release();

    const next = owner.acquire();
    request.resolve(late.stream);
    await expect(stale).rejects.toBeInstanceOf(MediaAcquireError);
    await expect(next).resolves.toBe(fresh.stream);
    expect(late.tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
    expect(owner.current()).toBe(fresh.stream);
  });

  it("release stops every track", async () => {
    const { stream, tracks } = fakeStream();
    const owner = createMediaOwner(async () => stream);
    await owner.acquire();
    owner.release();
    expect(tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
    expect(owner.current()).toBeNull();
  });

  it("rejects as unsupported without getUserMedia", async () => {
    const owner = createMediaOwner(null);
    await expect(owner.acquire()).rejects.toMatchObject({ code: "unsupported" });
  });
});

describe("media helpers", () => {
  it("maps browser errors to media errors", () => {
    expect(toMediaError(new DOMException("no", "NotAllowedError"))).toBe("denied");
    expect(toMediaError(new DOMException("no", "NotFoundError"))).toBe("not_found");
    expect(toMediaError(new MediaAcquireError("unsupported"))).toBe("unsupported");
    expect(toMediaError(new Error("boom"))).toBe("failed");
  });

  it("treats a stream with no tracks as not live", () => {
    expect(isStreamLive({ getTracks: () => [] } as unknown as MediaStream)).toBe(false);
    expect(isStreamLive(fakeStream().stream)).toBe(true);
  });
});
