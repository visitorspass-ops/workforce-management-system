import { redirect } from "next/navigation";
import { getCurrentUserAndRole } from "@/lib/auth";
import { Sidebar } from "@/components/Sidebar";

/**
 * Shared shell for every authenticated view. middleware.ts already blocks
 * an unauthenticated request; this layout handles the case that's easy to
 * miss — a real, signed-in account with NO role assigned yet. That's not
 * an error, it's someone waiting on an admin, so it gets its own screen
 * rather than a broken nav or a silent redirect loop.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { email, role } = await getCurrentUserAndRole();

  if (!email) redirect("/login");

  if (!role) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <div className="font-mono text-xs text-amber uppercase tracking-widest mb-2">Access pending</div>
          <p className="text-sm text-muted">
            You&apos;re signed in as <span className="text-text font-mono">{email}</span>, but no role has been
            assigned yet. Ask an admin to add you to <code className="text-text">user_roles</code> before you can
            open the dashboards.
          </p>
        </div>
      </main>
    );
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar role={role} email={email} />
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
