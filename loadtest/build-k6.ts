// Builds loadtest/bin/k6[.exe]: k6 plus the xk6-sse extension, pinned in config.json. Uses the
// grafana/xk6 image, so no local Go toolchain is needed.
import { join } from "@std/path";
import { LOADTEST_DIR, loadConfig, run } from "./lib.ts";

const config = await loadConfig();
const windows = Deno.build.os === "windows";
const binDir = join(LOADTEST_DIR, "bin");
await Deno.mkdir(binDir, { recursive: true });

const output = windows ? "k6.exe" : "k6";
const { code, stdout, stderr } = await run("docker", [
  "run",
  "--rm",
  "-e",
  `GOOS=${windows ? "windows" : Deno.build.os}`,
  "-e",
  "GOARCH=amd64",
  "-v",
  `${binDir}:/xk6`,
  config.pins.xk6Image,
  "build",
  config.pins.k6,
  "--with",
  config.pins.xk6Sse,
  "--output",
  `/xk6/${output}`,
], { allowFailure: true });
console.log(stdout, stderr);
if (code !== 0) {
  Deno.exit(code);
}
console.log(`built ${join(binDir, output)}`);
