type SitePage = "today" | "inbox" | "chat" | "activity" | "settings";

const pages: Array<{ id: SitePage; label: string; href: string }> = [
  { id: "today", label: "Today", href: "/" },
  { id: "inbox", label: "Inbox", href: "/inbox" },
  { id: "chat", label: "Chat", href: "/chat" },
  { id: "activity", label: "Activity", href: "/activity" },
  { id: "settings", label: "Settings", href: "/settings" },
];

export function SiteNav({ current }: { current?: SitePage }) {
  return (
    <header className="topbar">
      <a className="wordmark" href="/" aria-label="Brewlytics home">
        <span className="wordmark-mark" aria-hidden="true">B</span>
        <span>Brewlytics</span>
      </a>
      <nav className="topbar-nav" aria-label="Main navigation">
        {pages.map((page) => (
          <a
            href={page.href}
            key={page.id}
            aria-current={page.id === current ? "page" : undefined}
          >
            {page.label}
          </a>
        ))}
      </nav>
    </header>
  );
}
