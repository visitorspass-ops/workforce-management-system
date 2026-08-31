/**
 * Locad WFM — ingestion worker
 * ------------------------------
 * The HTTP endpoint the Supabase Database Webhook calls automatically when
 * a new row lands in `ingestion_jobs` (per 'Cis's "automatic on upload"
 * choice — the insert in app/(app)/upload/page.tsx is what triggers this,
 * via a webhook configured in the Supabase dashboard, not from this app).
 *
 * This is a small always-on Node process, NOT a Vercel function — DuckDB
 * over 6.5M+ rows takes minutes, past any serverless request limit. It
 * runs wherever 'Cis hosts it (Railway/Fly/Render/a VM — see README.md in
 * this folder) and needs three things reachable: Supabase Storage (to
 * download the uploaded files), Supabase Postgres (DATABASE_URL, to write
 * results — same target the app reads from), and the `ingestion_jobs`
 * table (to read/update job status, service-role key).
 *
 * Rebuild semantics: every run re-downloads the FULL current set of files
 * under raw-uploads/transactions/ and raw-uploads/attendance/ — not just
 * the file that triggered this call — because a worker-day's duration
 * depends on that worker's NEXT scan, which can sit in a different file
 * (documented in ingest-core/run.ts). Reference files (benchmark,
 * brand_fallback, sku_map, name_map) use only the most recently uploaded
 * file of each kind — those are wholesale-replaced tables, not date-scoped.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createClient } from "@supabase/supabase-js";
import { runIngestion } from "../ingest-core/run";

const PORT = Number(process.env.PORT ?? 8787);
const WEBHOOK_SECRET = requireEnv("WEBHOOK_SECRET"); // matches the Bearer token set in the Supabase webhook config
const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const DATABASE_URL = requireEnv("DATABASE_URL");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} — see worker/README.md`);
  return v;
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/** Downloads every object under raw-uploads/<kind>/ into a fresh temp dir. */
async function downloadAllOfKind(kind: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wfm-${kind}-`));
  const { data: files, error } = await supabase.storage.from("raw-uploads").list(kind, { limit: 1000 });
  if (error) throw new Error(`Listing raw-uploads/${kind}: ${error.message}`);
  if (!files || files.length === 0) throw new Error(`No files found under raw-uploads/${kind}/`);

  for (const f of files) {
    const { data, error: dlErr } = await supabase.storage.from("raw-uploads").download(`${kind}/${f.name}`);
    if (dlErr) throw new Error(`Downloading ${kind}/${f.name}: ${dlErr.message}`);
    fs.writeFileSync(path.join(dir, f.name), Buffer.from(await data.arrayBuffer()));
  }
  return dir;
}

/** For a wholesale-replace reference kind, only the most recently uploaded
 *  file matters — downloads just that one and returns its local path. */
async function downloadLatestOfKind(kind: string): Promise<string> {
  const { data: files, error } = await supabase.storage.from("raw-uploads").list(kind, { limit: 1000 });
  if (error) throw new Error(`Listing raw-uploads/${kind}: ${error.message}`);
  if (!files || files.length === 0) throw new Error(`No files found under raw-uploads/${kind}/`);

  // Filenames are `${Date.now()}-${originalName}` (see upload/page.tsx), so
  // a plain string sort already orders oldest → newest.
  const latest = files.sort((a, b) => a.name.localeCompare(b.name)).at(-1)!;
  const { data, error: dlErr } = await supabase.storage.from("raw-uploads").download(`${kind}/${latest.name}`);
  if (dlErr) throw new Error(`Downloading ${kind}/${latest.name}: ${dlErr.message}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wfm-${kind}-`));
  const localPath = path.join(dir, latest.name);
  fs.writeFileSync(localPath, Buffer.from(await data.arrayBuffer()));
  return localPath;
}

async function processJob(jobId: string) {
  await supabase.from("ingestion_jobs").update({ status: "processing" }).eq("id", jobId);
  try {
    const [txDir, attDir, benchmarkFile, fallbackFile, skuMapFile, nameMapFile] = await Promise.all([
      downloadAllOfKind("transactions"),
      downloadAllOfKind("attendance"),
      downloadLatestOfKind("benchmark"),
      downloadLatestOfKind("brand_fallback"),
      downloadLatestOfKind("sku_map"),
      downloadLatestOfKind("name_map"),
    ]);

    const result = await runIngestion({
      txDir,
      attDir,
      benchmarkFile,
      fallbackFile,
      skuMapFile,
      nameMapFile,
      databaseUrl: DATABASE_URL,
      log: (msg) => console.log(`[job ${jobId}]`, msg),
    });

    await supabase.from("ingestion_jobs").update({ status: "done" }).eq("id", jobId);
    console.log(`[job ${jobId}] done — ${result.rawRows} raw rows, ${result.curatedRows} curated lines`);
  } catch (err: any) {
    console.error(`[job ${jobId}] failed`, err);
    await supabase
      .from("ingestion_jobs")
      .update({ status: "error", error_message: String(err?.message ?? err).slice(0, 2000) })
      .eq("id", jobId);
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/process") {
    res.writeHead(404).end();
    return;
  }

  const auth = req.headers["authorization"];
  if (auth !== `Bearer ${WEBHOOK_SECRET}`) {
    res.writeHead(401).end("unauthorized");
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    // Supabase Database Webhook payload shape: { type: "INSERT", table: "ingestion_jobs", record: {...}, ... }
    let payload: any;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400).end("invalid json");
      return;
    }

    const jobId = payload?.record?.id;
    if (!jobId) {
      res.writeHead(400).end("missing record.id");
      return;
    }

    // Ack immediately — the webhook has its own timeout, and this job can
    // take minutes. Processing continues in the background; status is
    // tracked in ingestion_jobs, which the upload page polls.
    res.writeHead(202).end("accepted");
    processJob(jobId).catch((err) => console.error(`[job ${jobId}] unhandled`, err));
  });
});

server.listen(PORT, () => {
  console.log(`WFM ingestion worker listening on :${PORT}`);
});
