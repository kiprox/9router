import { DashboardLayout } from "@/shared/components";

// Dashboard pages are auth-gated and embed build-time data (e.g. APP_CONFIG
// version). Without this they are prerendered static with
// `cache-control: s-maxage=31536000`, so any cache layer (Next ISR cache,
// nginx, CDN) can serve a stale shell for a year after an upgrade: old chunk
// names 404, the sidebar shows the old version, and the cached HTML bypasses
// the login redirect. force-dynamic keeps every dashboard HTML fresh.
export const dynamic = "force-dynamic";

export default function DashboardRootLayout({ children }) {
  return <DashboardLayout>{children}</DashboardLayout>;
}

