import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WEB_DIR } from "./env";

const SAMPLE_RATE = 48_000;
const SECONDS = 2;
const FREQUENCY_HZ = 440;
const AMPLITUDE = 0.5;

/**
 * A looping 440 Hz tone for Chromium's fake microphone. The default fake device only beeps
 * briefly, so the lobby's level meter could miss it; a continuous tone passes the check every run.
 */
export function ensureToneWav(): string {
  const file = path.join(WEB_DIR, "e2e/.cache/tone.wav");
  if (existsSync(file)) {
    return file;
  }
  const samples = SAMPLE_RATE * SECONDS;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = Math.sin((2 * Math.PI * FREQUENCY_HZ * i) / SAMPLE_RATE) * AMPLITUDE;
    data.writeInt16LE(Math.round(value * 0x7fff), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat([header, data]));
  return file;
}
