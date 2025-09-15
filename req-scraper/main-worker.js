import { run } from "graphile-worker";
import { pool } from "./db/pool.js";

async function main() {
  console.log("Starting REQ Enterprise Scraper...");

  const runner = await run({
    pgPool: pool,
    concurrency: 3, // Start with 3 concurrent workers
    noHandleSignals: false,
    pollInterval: 5000,
    taskDirectory: `${import.meta.dirname}/tasks`,
  });

  console.log("REQ scraper is running. Waiting for jobs...");
  await runner.promise;
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});