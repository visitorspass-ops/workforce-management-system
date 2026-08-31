"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/browser";

// useSearchParams() opts a client component out of static rendering unless
// wrapped in Suspense — this default export is just that boundary; the
// actual form (and the ?next= redirect target read) lives in LoginForm.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/view1";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"password" | "magic-link">("password");
  const [status, setStatus] = useState<"idle" | "loading" | "sent" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function handlePasswordLogin(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    const supabase = supabaseBrowser();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setStatus("error");
      setErrorMsg(error.message);
      return;
    }
    router.push(next);
    router.refresh();
  }

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    const supabase = supabaseBrowser();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=${next}` },
    });
    if (error) {
      setStatus("error");
      setErrorMsg(error.message);
      return;
    }
    setStatus("sent");
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm bg-panel border border-border rounded-xl p-6">
        <div className="font-mono text-xs text-go tracking-widest uppercase mb-1">Locad · WFM</div>
        <h1 className="font-display text-xl font-bold mb-5">Sign in</h1>

        <div className="flex gap-2 mb-4">
          <button
            className={`font-mono text-[11px] px-2.5 py-1 rounded ${mode === "password" ? "bg-goDim text-go" : "text-muted border border-border"}`}
            onClick={() => setMode("password")}
            type="button"
          >
            Password
          </button>
          <button
            className={`font-mono text-[11px] px-2.5 py-1 rounded ${mode === "magic-link" ? "bg-goDim text-go" : "text-muted border border-border"}`}
            onClick={() => setMode("magic-link")}
            type="button"
          >
            Magic link
          </button>
        </div>

        <form onSubmit={mode === "password" ? handlePasswordLogin : handleMagicLink} className="flex flex-col gap-3">
          <input
            type="email"
            required
            placeholder="you@locadcby.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="bg-panel2 border border-border rounded-md px-3 py-2 text-sm text-text font-mono"
          />
          {mode === "password" && (
            <input
              type="password"
              required
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="bg-panel2 border border-border rounded-md px-3 py-2 text-sm text-text font-mono"
            />
          )}
          <button
            type="submit"
            disabled={status === "loading"}
            className="bg-go text-[#031407] font-display font-bold rounded-md py-2 text-sm disabled:opacity-60"
          >
            {status === "loading" ? "…" : mode === "password" ? "Sign in" : "Send magic link"}
          </button>
          {status === "sent" && <div className="text-go text-xs font-mono">Check your email for the sign-in link.</div>}
          {status === "error" && <div className="text-red text-xs font-mono">{errorMsg}</div>}
        </form>

        <div className="text-muted text-[10.5px] font-mono mt-4">
          Access is role-gated (admin / supervisor / manager). Ask an admin to create your account and
          role if you don&apos;t have one yet.
        </div>
      </div>
    </main>
  );
}
