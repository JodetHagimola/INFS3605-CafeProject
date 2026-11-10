"use client";

import { useEffect, useState } from "react";

const format = new Intl.DateTimeFormat("en-AU", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Australia/Sydney",
});

export default function InventoryStockTime({ value }: { value: string }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  return <>{mounted && Number.isFinite(Date.parse(value)) ? format.format(new Date(value)) : "—"}</>;
}
