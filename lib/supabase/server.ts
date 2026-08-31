import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase client. Reads connection details from env vars that
 * 'Cis sets directly in the Vercel project dashboard — never hardcoded,
 * never passed through chat. See README.md "Environment variables" for the
 * exact names Vercel needs.
 *
 * Uses the service role key because View 1 / View 2 read pre-aggregated
 * tables (brand_daily_agg, packer_daily_agg) that are not meant to be
 * exposed to the browser directly — all reads happen in Server Components.
 */
let cached: SupabaseClient | null = null;

export function supabaseServer(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Set these in the " +
        "Vercel project's Environment Variables — see README.md."
    );
  }

  cached = createClient(url, key, {
    auth: { persistSession: false },
  });
  return cached;
}
