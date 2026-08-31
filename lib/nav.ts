/**
 * Client-safe nav config — split out of lib/auth.ts so components like
 * Sidebar ("use client") never pull next/headers into the browser bundle.
 * lib/auth.ts re-exports Role from here so server code has one source too.
 */
export type Role = "admin" | "supervisor" | "manager";

export const NAV_ITEMS: { href: string; label: string; icon: string; roles: Role[] }[] = [
  { href: "/view1", label: "Per Brand Execution", icon: "◆", roles: ["admin", "supervisor", "manager"] },
  { href: "/view2", label: "Packer Overview", icon: "◇", roles: ["admin", "supervisor", "manager"] },
  // "different barrier" — upload is intentionally NOT visible to every role
  // that can view the dashboards; only the roles allowed to write get the
  // nav item. RLS on ingestion_jobs/storage.objects enforces this for real,
  // this list only controls what's shown.
  { href: "/upload", label: "Upload Data", icon: "⇧", roles: ["admin", "supervisor", "manager"] },
];
