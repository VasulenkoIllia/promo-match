import { config } from "./config.js";

// One image, two roles: the HTTP app, or with WORKER=<name> a one-off job such as the catalogue import
// (src/worker.ts), which exits when done
if (config.worker) {
  const { runWorker } = await import("./worker.js");
  process.exitCode = await runWorker(config.worker, process.argv.slice(2));
} else {
  const { startServer } = await import("./server.js");
  await startServer();
}
