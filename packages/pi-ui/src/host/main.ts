import { startPiHost } from "./server.js";

const host = await startPiHost();
let closing = false;

const close = async () => {
  if (closing) return;
  closing = true;
  await host.close();
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void close().finally(() => {
      process.exitCode = 0;
    });
  });
}

// The capability URL is displayed only in this local terminal; never put it in HTTP logs.
process.stdout.write(`Pi UI (local, ephemeral): ${host.url}\nPress Ctrl+C to stop.\n`);
