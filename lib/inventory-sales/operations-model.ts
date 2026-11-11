export function sydneyDay(timestamp: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid operation timestamp");
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

export type RecordedOperations = {
  date: string;
  transactionCount: number;
  drinksRecorded: number;
  products: { name: string; quantity: number }[];
  ingredientsUsed: { name: string; unit: string; amount: string }[];
  deliveriesReceived: { name: string; unit: string; amount: string }[];
};
