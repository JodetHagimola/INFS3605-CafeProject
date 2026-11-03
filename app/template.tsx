import { ViewTransition } from "react";

export default function Template({ children }: { children: React.ReactNode }) {
  return (
    <ViewTransition enter="loading-fade-in" default="none">
      <div className="route-enter">{children}</div>
    </ViewTransition>
  );
}
