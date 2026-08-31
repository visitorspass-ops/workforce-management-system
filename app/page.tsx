import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <div className="font-mono text-xs text-go tracking-widest uppercase mb-2">
          Locad · WFM
        </div>
        <h1 className="font-display text-2xl font-bold mb-6">Shift Manifest</h1>
        <div className="flex gap-4 justify-center">
          <Link
            href="/view1"
            className="border border-goDim text-go px-5 py-2 rounded-lg font-mono text-sm hover:bg-panel2 transition"
          >
            View 1 · Per Brand Execution
          </Link>
          <Link
            href="/view2"
            className="border border-goDim text-go px-5 py-2 rounded-lg font-mono text-sm hover:bg-panel2 transition"
          >
            View 2 · Packer Overview
          </Link>
        </div>
      </div>
    </main>
  );
}
