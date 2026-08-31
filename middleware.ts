import { NextRequest, NextResponse } from "next/server";
import { supabaseMiddlewareClient } from "@/lib/supabase/middleware-client";

const PROTECTED_PREFIXES = ["/view1", "/view2", "/upload"];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = supabaseMiddlewareClient(request, response);

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isProtected = PROTECTED_PREFIXES.some((p) => request.nextUrl.pathname.startsWith(p));

  if (isProtected && !user) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: ["/view1/:path*", "/view2/:path*", "/upload/:path*"],
};
