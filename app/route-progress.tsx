"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

export function RouteProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let timeout: number | undefined;
    function start() {
      setPending(true);
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => setPending(false), 5000);
    }

    function onClick(event: MouseEvent) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.target || anchor.hasAttribute("download")) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      if (destination.pathname === window.location.pathname
        && destination.search === window.location.search) return;
      start();
    }
    function onProgrammaticNavigation() {
      start();
    }

    document.addEventListener("click", onClick);
    window.addEventListener("brewlytics:navigation-start", onProgrammaticNavigation);
    return () => {
      document.removeEventListener("click", onClick);
      window.removeEventListener("brewlytics:navigation-start", onProgrammaticNavigation);
      window.clearTimeout(timeout);
    };
  }, []);

  useEffect(() => {
    setPending(false);
  }, [pathname, search]);

  return (
    <div
      className={`route-progress${pending ? " route-progress-active" : ""}`}
      role={pending ? "progressbar" : undefined}
      aria-label={pending ? "Loading page" : undefined}
      aria-valuetext={pending ? "Loading" : undefined}
      aria-hidden={!pending}
    />
  );
}
