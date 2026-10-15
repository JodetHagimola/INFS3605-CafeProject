"use server";

import { revalidatePath } from "next/cache";
import { createOrder } from "@/lib/supabase/server";

export type CreateOrderState = {
  message: string;
  status: "idle" | "success" | "error";
};

export async function createOrderAction(
  _previousState: CreateOrderState,
  _formData: FormData,
): Promise<CreateOrderState> {
  const result = await createOrder();

  if (result.error) {
    return { message: result.error, status: "error" };
  }

  revalidatePath("/");
  return { message: "Order added.", status: "success" };
}
