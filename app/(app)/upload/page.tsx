"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

type Kind = "transactions" | "attendance" | "benchmark" | "brand_fallback" | "sku_map" | "name_map";

const KIND_LABEL: Record<Kind, string> = {
  transactions: "Transaction log",
  attendance: "Attendance",
  benchmark: "Line benchmark",
  brand_fallback: "Brand fallback benchmark",
  sku_map: "SKU / product name map",
  name_map: "Name ↔ WMS login map",
};

/** Cheap client-side sniff so multi-file drops default to the right kind —
 *  same idea as the original prototype's classifyRows(), just header-based
 *  instead of a full parse. The dropdown lets someone correct a miss. */
function guessKind(filename: string, firstLine: string): Kind {
  const cols = firstLine.toLowerCase();
  if (cols.includes("transaction type") && cols.includes("transaction date")) return "transactions";
  if (cols.includes("sign in time") || cols.includes("employer")) return "attendance";
  if (cols.includes("signature") && cols.includes("usable")) return "benchmark";
  if (cols.includes("client") && cols.includes("p50") && cols.includes("trimmed")) return "brand_fallback";
  if (cols.includes("product sku")) return "sku_map";
  if (cols.includes("transaction_user_login") || cols.includes("employee_id")) return "name_map";
  return "transactions";
}

type QueuedFile = { file: File; kind: Kind; id: string };
type JobRow = {
  id: string;
  storage_path: string;
  kind: Kind;
  status: "pending" | "processing" | "done" | "error";
  error_message: string | null;
  created_at: string;
};

export default function UploadPage() {
  const [queued, setQueued] = useState<QueuedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const dropRef = useRef<HTMLDivElement>(null);

  const refreshJobs = useCallback(async () => {
    const { data } = await supabaseBrowser().from("ingestion_jobs").select("*").order("created_at", { ascending: false }).limit(30);
    if (data) setJobs(data as JobRow[]);
  }, []);

  useEffect(() => {
    refreshJobs();
    const hasActive = jobs.some((j) => j.status === "pending" || j.status === "processing");
    const interval = setInterval(refreshJobs, hasActive ? 3000 : 8000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshJobs, jobs.length]);

  async function addFiles(files: FileList | File[]) {
    const next: QueuedFile[] = [];
    for (const file of Array.from(files)) {
      const head = await file.slice(0, 2000).text();
      const firstLine = head.split("\n")[0] ?? "";
      next.push({ file, kind: guessKind(file.name, firstLine), id: `${file.name}-${file.size}-${Date.now()}-${Math.random()}` });
    }
    setQueued((q) => [...q, ...next]);
  }

  async function upload() {
    setUploading(true);
    const supabase = supabaseBrowser();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    for (const item of queued) {
      const path = `${item.kind}/${Date.now()}-${item.file.name}`;
      const { error: uploadErr } = await supabase.storage.from("raw-uploads").upload(path, item.file, { upsert: false });
      if (uploadErr) {
        console.error("Upload failed for", item.file.name, uploadErr.message);
        continue;
      }
      // Inserting this row is what fires the Database Webhook — automatic
      // processing on upload, per 'Cis's choice. RLS (jobs insertable by
      // admin/supervisor/manager) is the real access-control point, not
      // this page — a non-privileged account's insert would be rejected
      // here even if they somehow reached this screen.
      await supabase.from("ingestion_jobs").insert({ storage_path: path, kind: item.kind, uploaded_by: user?.id });
    }
    setQueued([]);
    setUploading(false);
    refreshJobs();
  }

  return (
    <main className="min-h-screen p-7 max-w-4xl">
      <h1 className="font-display text-2xl font-bold mb-1">Upload Data</h1>
      <p className="font-mono text-xs text-muted mb-6">
        Transaction logs, attendance, benchmarks, and mapping files — any mix, any number of files. Processing
        starts automatically once a file finishes uploading; it can take a few minutes for large transaction logs.
      </p>

      <div
        ref={dropRef}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        }}
        onClick={() => document.getElementById("fileInput")?.click()}
        className="border-2 border-dashed border-border rounded-xl p-9 text-center cursor-pointer hover:border-go transition mb-5"
      >
        <div className="font-display text-base mb-1">Drop files here, or click to choose</div>
        <div className="font-mono text-xs text-muted">.csv, .xlsx — any mix, any number</div>
        <input
          id="fileInput"
          type="file"
          multiple
          accept=".csv,.xlsx,.xls"
          className="hidden"
          onChange={(e) => e.target.files && addFiles(e.target.files)}
        />
      </div>

      {queued.length > 0 && (
        <div className="bg-panel border border-border rounded-lg p-4 mb-5">
          <div className="font-mono text-[11px] uppercase text-muted mb-3">{queued.length} file(s) ready to upload</div>
          <div className="flex flex-col gap-2 mb-4">
            {queued.map((q) => (
              <div key={q.id} className="flex items-center gap-3 font-mono text-[12.5px]">
                <span className="flex-1 truncate">{q.file.name}</span>
                <select
                  value={q.kind}
                  onChange={(e) =>
                    setQueued((prev) => prev.map((p) => (p.id === q.id ? { ...p, kind: e.target.value as Kind } : p)))
                  }
                  className="bg-panel2 border border-border rounded px-2 py-1 text-[11px]"
                >
                  {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => setQueued((prev) => prev.filter((p) => p.id !== q.id))}
                  className="text-muted hover:text-red text-xs"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <button
            onClick={upload}
            disabled={uploading}
            className="bg-go text-[#031407] font-display font-bold rounded-md px-4 py-2 text-sm disabled:opacity-60"
          >
            {uploading ? "Uploading…" : `Upload ${queued.length} file(s)`}
          </button>
        </div>
      )}

      <div className="font-display text-base font-semibold mb-2.5">Recent uploads</div>
      <div className="flex flex-col gap-2">
        {jobs.map((j) => (
          <div key={j.id} className="flex items-center gap-3 font-mono text-[12px] bg-panel border border-border rounded-md px-3 py-2">
            <span className="flex-1 truncate">{j.storage_path}</span>
            <span className="text-muted">{KIND_LABEL[j.kind]}</span>
            <StatusBadge status={j.status} />
          </div>
        ))}
        {jobs.length === 0 && <div className="text-muted font-mono text-xs">No uploads yet.</div>}
      </div>
    </main>
  );
}

function StatusBadge({ status }: { status: JobRow["status"] }) {
  const cls =
    status === "done"
      ? "bg-goDim text-go"
      : status === "error"
        ? "bg-redDim text-[#ffb3b6]"
        : status === "processing"
          ? "bg-amberDim text-amber"
          : "bg-panel2 text-muted border border-border";
  return <span className={`badge-pill ${cls}`}>{status}</span>;
}
