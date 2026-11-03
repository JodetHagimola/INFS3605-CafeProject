import type { Metadata } from "next";
import { Suspense } from "react";
import "./globals.css";
import { hasAgentSession } from "@/lib/agent/auth";
import { AgentDock } from "./agent-dock";
import { LoginScreen } from "./auth/login-screen";
import { RouteProgress } from "./route-progress";

export const metadata: Metadata = {
  title: "Brewlytics",
  description: "A clearer day at your café, from inventory to orders.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const authenticated = await hasAgentSession();
  return (
    <html lang="en">
      <body>{authenticated ? <><Suspense fallback={null}><RouteProgress /></Suspense>{children}<AgentDock /></> : <LoginScreen />}</body>
    </html>
  );
}
