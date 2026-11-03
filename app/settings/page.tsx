import type { Metadata } from "next";
import { SiteNav } from "../site-nav";
import { SettingsPanel } from "./settings-panel";

export const metadata: Metadata = { title: "Settings | Brewlytics" };

export default function SettingsPage() {
  return (
    <main className="page-shell">
      <SiteNav current="settings" />
      <section className="orders-section" aria-labelledby="settings-title">
        <p className="eyebrow">WORKSPACE</p>
        <h1 id="settings-title">Settings</h1>
        <p className="section-description">Manage approval boundaries and prepare a simulated day for a demo.</p>
        <SettingsPanel />
      </section>
    </main>
  );
}
