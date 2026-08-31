"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS, type Role } from "@/lib/nav";
import { SignOutButton } from "@/components/SignOutButton";

/**
 * Shared shell nav — the "one area, separated by barrier" piece: View 1,
 * View 2, and Upload all live in this same app; which items render is
 * driven by the signed-in user's role, not a separate site per view.
 */
export function Sidebar({ role, email }: { role: Role; email: string | null }) {
  const activePath = usePathname();
  const items = NAV_ITEMS.filter((item) => item.roles.includes(role));

  return (
    <nav className="w-60 shrink-0 bg-[#030604] border-r border-border flex flex-col py-5">
      <div className="px-5 pb-4.5 border-b border-border mb-2.5">
        <div className="font-mono text-[10px] text-go tracking-widest uppercase mb-1.5">Locad · WFM</div>
        <h1 className="font-display text-lg font-bold leading-tight">Shift Manifest</h1>
      </div>
      <ul className="list-none m-0 p-0">
        {items.map((item) => {
          const active = activePath.startsWith(item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={`flex items-center gap-2.5 px-5 py-3 text-[13.5px] border-l-2 transition ${
                  active ? "text-go border-go bg-[#09120b] font-semibold" : "text-muted border-transparent hover:text-text hover:bg-[#09120b]"
                }`}
              >
                <span className={`font-mono text-[13px] w-4 ${active ? "text-go" : "text-goDim"}`}>{item.icon}</span>
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="mt-auto px-5 pt-4 border-t border-border">
        <div className="text-[10px] text-muted uppercase tracking-wide mb-0.5">Signed in as</div>
        <div className="text-[12px] font-mono mb-1">{email}</div>
        <div className="text-[10px] font-mono text-go uppercase mb-3">{role}</div>
        <SignOutButton />
      </div>
    </nav>
  );
}
