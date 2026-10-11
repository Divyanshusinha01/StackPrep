// Writes schedule.json from config.json. The schedule is committed; regenerating it with a changed
// config invalidates any comparison with results produced from the old one.
import { join } from "@std/path";
import { createRng, LOADTEST_DIR, loadConfig, type Schedule, type ScheduleAction, writeJson } from "./lib.ts";

const config = await loadConfig();
const { warmupMs, holdMs, reportAfterCompleteMs } = config.timing;
const { turnIntervalMs, voiceEventIntervalMs, turnContentChars } = config.workload;
const maxInterviews = Math.max(...config.stages, ...config.extensionStages);
const activeMs = warmupMs + holdMs;

const rng = createRng(config.seed);
const offsetsMs = Array.from({ length: maxInterviews }, () => Math.floor(rng() * turnIntervalMs));

const actions: ScheduleAction[] = [];
for (let at = 0, turn = 0; at < activeMs - turnIntervalMs; at += turnIntervalMs, turn++) {
  actions.push({ atMs: at, kind: "transcript_turn", role: turn % 2 === 0 ? "ai" : "user" });
}
// A voice drop and reconnect: non-streamed interview_events rows between the streamed ones.
for (let at = voiceEventIntervalMs / 2; at < activeMs - turnIntervalMs; at += voiceEventIntervalMs) {
  actions.push({ atMs: at, kind: "disconnected" });
  actions.push({ atMs: at + 1_000, kind: "connected" });
}
actions.sort((a, b) => a.atMs - b.atMs);

const schedule: Schedule = {
  seed: config.seed,
  maxInterviews,
  offsetsMs,
  actions,
  completeAtMs: activeMs,
  reportAfterMs: reportAfterCompleteMs,
  turnContentChars,
};
await writeJson(join(LOADTEST_DIR, "schedule.json"), schedule);
console.log(`schedule.json: ${actions.length} actions per interview, ${maxInterviews} offsets`);
