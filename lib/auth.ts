import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export type { Role } from "./nav";
export { NAV_ITEMS } from "./nav";
import type { Role } from "./nav";

/** Session-aware server client for Server Components (reads the signed-in
 *  user's cookie session, anon key, RLS applies). Distinct from
 *  lib/supabase/server.ts's service-role client, which is for the
 *  pre-aggregated dashboard reads only. */
function supabaseServerSession() {
  const cookieStore = cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: () => {
        /* no-op in a Server Component — middleware.ts owns cookie writes */
      },
    },
  });
}

export async function getCurrentUserAndRole(): Promise<{ email: string | null; role: Role | null }> {
  const supabase = supabaseServerSession();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { email: null, role: null };

  const { data: roleRow } = await supabase.from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
  return { email: user.email ?? null, role: (roleRow?.role as Role) ?? null };
}
