import { parseEnv, workerEnvSchema } from "@stackprep/shared";

const env = parseEnv("worker", workerEnvSchema, process.env);

console.log(`worker ready (${env.NODE_ENV})`);

const keepAlive = setInterval(() => {}, 1 << 30);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    clearInterval(keepAlive);
    process.exit(0);
  });
}
