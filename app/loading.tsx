"use client";

import { ViewTransition, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Skeleton } from "./ui/feedback";

const briefStages = [
  "Checking stock...",
  "Looking at deliveries...",
  "Forecasting demand...",
];

export default function Loading() {
  const pathname = usePathname();
  const [stage, setStage] = useState(0);
  const isToday = pathname === "/";

  useEffect(() => {
    if (!isToday) return;
    const interval = window.setInterval(() => {
      setStage((current) => (current + 1) % briefStages.length);
    }, 1400);
    return () => window.clearInterval(interval);
  }, [isToday]);

  return (
    <ViewTransition exit="loading-fade-out" default="none">
      <main className="page-shell loading-page" aria-busy="true">
        <section className="loading-content" aria-live="polite">
          <p className="eyebrow">{isToday ? "DAILY BRIEF" : "BREWLYTICS"}</p>
          <h1>{isToday ? "Preparing today's brief" : "Preparing your workspace"}</h1>
          <p className="inline-status">
            <span className="typing-dots" aria-hidden="true"><span /><span /><span /></span>
            {isToday ? briefStages[stage] : "Loading your café workspace..."}
          </p>
          <div className="loading-cards">
            {Array.from({ length: 3 }, (_, index) => (
              <section className="skeleton-card" key={index}>
                <Skeleton className="skeleton-line" />
                <Skeleton className="skeleton-line" />
                <Skeleton className="skeleton-line" />
              </section>
            ))}
          </div>
        </section>
      </main>
    </ViewTransition>
  );
}
