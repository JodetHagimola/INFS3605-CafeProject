"use server";

import { revalidatePath } from "next/cache";
import { parseOrderRequestItems } from "@/lib/order-requests/model";
import { createOrderRequest, decideOrderRequest } from "@/lib/order-requests/server";

export type OrderRequestActionState = {
  status: "idle" | "success" | "error";
  message: string;
  resetVersion: number;
};

export type DecisionActionState = {
  status: "idle" | "error";
  message: string;
};

export async function submitOrderRequest(
  previous: OrderRequestActionState,
  formData: FormData,
): Promise<OrderRequestActionState> {
  const chefName = String(formData.get("chefName") ?? "").trim();
  const neededBy = String(formData.get("neededBy") ?? "");
  const notes = String(formData.get("notes") ?? "").trim();

  if (!chefName || chefName.length > 80) {
    return { status: "error", message: "Enter the chef's name (up to 80 characters).", resetVersion: previous.resetVersion };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(neededBy) || neededBy < new Date().toISOString().slice(0, 10)) {
    return { status: "error", message: "Choose a valid needed-by date that is today or later.", resetVersion: previous.resetVersion };
  }
  if (new Date(`${neededBy}T00:00:00.000Z`).toISOString().slice(0, 10) !== neededBy) {
    return { status: "error", message: "Choose a valid needed-by date that is today or later.", resetVersion: previous.resetVersion };
  }
  if (notes.length > 500) {
    return { status: "error", message: "Notes must be 500 characters or fewer.", resetVersion: previous.resetVersion };
  }

  const parsed = parseOrderRequestItems(
    formData.getAll("itemName"),
    formData.getAll("itemQuantity"),
    formData.getAll("itemUnit"),
  );
  if (parsed.error !== null) {
    return { status: "error", message: parsed.error, resetVersion: previous.resetVersion };
  }

  const result = await createOrderRequest({ chefName, neededBy, notes, items: parsed.items });
  if (result.error) {
    return { status: "error", message: result.error, resetVersion: previous.resetVersion };
  }

  revalidatePath("/order-requests");
  return {
    status: "success",
    message: "Order submitted for approval.",
    resetVersion: previous.resetVersion + 1,
  };
}

export async function decideOrderRequestAction(
  id: string,
  status: "approved" | "rejected",
  _previous: DecisionActionState,
  formData: FormData,
): Promise<DecisionActionState> {
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return { status: "error", message: "This order request has an invalid ID." };
  }
  if (status !== "approved" && status !== "rejected") {
    return { status: "error", message: "Choose a valid order decision." };
  }

  const approverName = String(formData.get("approverName") ?? "").trim();
  const decisionNote = String(formData.get("decisionNote") ?? "").trim();
  if (!approverName || approverName.length > 80) {
    return { status: "error", message: "Enter the approver's name (up to 80 characters)." };
  }
  if (decisionNote.length > 500) {
    return { status: "error", message: "Decision notes must be 500 characters or fewer." };
  }

  const result = await decideOrderRequest({ id, status, approverName, decisionNote });
  if (result === "error") {
    return { status: "error", message: "The decision could not be saved. Check the Supabase setup and try again." };
  }
  if (result === "already-decided") {
    revalidatePath("/order-requests");
    return { status: "error", message: "This order has already been decided. Refresh the page to see its current status." };
  }

  revalidatePath("/order-requests");
  return { status: "idle", message: "" };
}
