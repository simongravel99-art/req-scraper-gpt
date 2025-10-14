import { run } from "graphile-worker";
import { pool } from "./db/pool.js";

async function main() {
  console.log("Starting REQ Enterprise Scraper...");

  const runner = await run({
    pgPool: pool,
    concurrency: 1, // Reduce to 1 worker to avoid rate limiting
    noHandleSignals: false,
    pollInterval: 8000, // Longer poll interval for Quebec servers
    taskDirectory: `${import.meta.dirname}/tasks`,
  });

  console.log("REQ scraper is running. Waiting for jobs...");
  await runner.promise;
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});