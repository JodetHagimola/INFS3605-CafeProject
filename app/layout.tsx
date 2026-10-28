import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Brewlytics",
  description: "A clearer day at your café, from inventory to orders.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
