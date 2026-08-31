"use client";

import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/browser";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      onClick={async () => {
        await supabaseBrowser().auth.signOut();
        router.push("/login");
        router.refresh();
      }}
      className="text-[11px] text-muted border border-border rounded-md px-2 py-1.5 w-full hover:text-red hover:border-red transition"
    >
      Sign out
    </button>
  );
}
