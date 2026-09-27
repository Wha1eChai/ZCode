import { startPiHost } from "./server.js";
import { parseToolModeArgs, type PiToolMode } from "./tool-mode.js";

async function main(): Promise<void> {
  let toolMode: PiToolMode;
  try {
    toolMode = parseToolModeArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Invalid Pi UI host arguments."}\n`,
    );
    process.exitCode = 2;
    return;
  }

  const host = await startPiHost({ toolMode });
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
}

await main();
