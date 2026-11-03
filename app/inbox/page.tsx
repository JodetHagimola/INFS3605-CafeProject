import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "Today | Brewlytics" };

export default function InboxPage() {
  redirect("/?review=1");
}
