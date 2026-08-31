"use client";

import { createBrowserClient } from "@supabase/ssr";

/** Anon-key client for the browser (login form, upload page). Respects RLS —
 *  this is deliberately NOT the service-role client in lib/supabase/server.ts. */
export function supabaseBrowser() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
