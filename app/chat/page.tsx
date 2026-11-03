import type { Metadata } from "next";
import { SiteNav } from "../site-nav";
import { ChatPanel } from "./chat-panel";

export const metadata: Metadata = { title: "Chat | Brewlytics" };

export default function ChatPage() {
  return (
    <main className="page-shell">
      <SiteNav current="chat" />
      <section className="orders-section" aria-labelledby="chat-title">
        <p className="eyebrow">ASK BREWLYTICS</p>
        <h1 id="chat-title">Chat with your agent</h1>
        <p className="section-description">
          Ask about stock, recipes, demand, suppliers, or deliveries. The agent
          uses available café data and asks for human review before any outside action.
        </p>
        <ChatPanel />
      </section>
    </main>
  );
}
