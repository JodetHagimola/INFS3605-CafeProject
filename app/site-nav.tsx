import Link from "next/link";
import { LogoutButton } from "./logout-button";

type SitePage = "today" | "activity" | "settings" | "stock" | "deliveries";

const pages: Array<{ id: SitePage; label: string; href: string }> = [
  { id: "today", label: "Today", href: "/" },
  { id: "stock", label: "Stock", href: "/inventory" },
  { id: "deliveries", label: "Deliveries", href: "/inventory/deliveries" },
  { id: "activity", label: "Activity", href: "/activity" },
  { id: "settings", label: "Settings", href: "/settings" },
];

export function SiteNav({ current }: { current?: SitePage }) {
  return (
    <header className="topbar">
      <Link className="wordmark" href="/" aria-label="Brewlytics home">
        <span className="wordmark-mark" aria-hidden="true">B</span>
        <span>Brewlytics</span>
      </Link>
      <nav className="topbar-nav" aria-label="Main navigation">
        {pages.map((page) => (
          <Link
            href={page.href}
            key={page.id}
            aria-current={page.id === current ? "page" : undefined}
          >
            {page.label}
          </Link>
        ))}
      </nav>
      <LogoutButton />
    </header>
  );
}
