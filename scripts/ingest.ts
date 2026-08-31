/**
 * Locad WFM — CLI wrapper around the shared ingestion core
 * ---------------------------------------------------------
 * Run with: npm run ingest -- --tx ./data/transactions --attendance ./data/attendance \
 *   --benchmark ./data/signal1_line_benchmark__Q2.csv \
 *   --fallback ./data/brandlevel_fallback__Q2.csv \
 *   --skumap ./data/sku_product_name_mapping.csv \
 *   --namemap ./data/name_wms_mapping.csv
 *
 * All the actual DuckDB logic lives in ingest-core/run.ts, shared with
 * worker/server.ts (the automatic-on-upload path) — this file only parses
 * CLI args/env vars and calls it. Keeping the two paths on one
 * implementation is deliberate: a rule fixed in ingest-core gets fixed for
 * both the manual run and the automatic worker, not just whichever one
 * someone remembered to patch.
 *
 * This is a standalone Node script, NOT a Vercel serverless function — at
 * Feb–Aug real volume (6.5M+ raw rows per agreed-operating-process.md) this
 * needs minutes, not the ~10-60s a Vercel function gets. Run it locally, in
 * CI, or by hand against the same Supabase project the app reads from.
 *
 * --tx and --attendance both take a DIRECTORY, not a single file — every
 * .csv/.xlsx inside is picked up automatically (glob + union_by_name).
 */
import { runIngestion } from "../ingest-core/run";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required --${name} argument`);
  }
  return v;
}

async function main() {
  const dbUrl = process.env.DATABASE_URL; // Supabase connection string (session pooler recommended)
  if (!dbUrl) {
    throw new Error(
      "DATABASE_URL not set. Use the Supabase project's connection string " +
        "(Project Settings → Database → Connection string), set as an env " +
        "var where this script runs — never pasted into chat."
    );
  }

  const result = await runIngestion({
    txDir: arg("tx"),
    attDir: arg("attendance"),
    benchmarkFile: arg("benchmark"),
    fallbackFile: arg("fallback"),
    skuMapFile: arg("skumap"),
    nameMapFile: arg("namemap"),
    databaseUrl: dbUrl,
    log: (msg) => console.log(msg),
  });

  console.log(`Done. ${result.rawRows} raw rows → ${result.curatedRows} curated packing lines.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
