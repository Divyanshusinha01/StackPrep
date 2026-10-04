import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { env } from "./env.ts";

const app = createApp({ webOrigin: env.WEB_ORIGIN });

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`api listening on http://localhost:${info.port} (${env.NODE_ENV})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close((err) => {
      if (err) {
        console.error(err);
        process.exit(1);
      }
      process.exit(0);
    });
  });
}
