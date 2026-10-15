"use client";

import { useActionState } from "react";
import { createOrderAction, type CreateOrderState } from "./actions";

const initialState: CreateOrderState = { message: "", status: "idle" };

export function OrderForm() {
  const [state, formAction, pending] = useActionState(
    createOrderAction,
    initialState,
  );

  return (
    <form className="order-form" action={formAction}>
      <p>Order IDs and creation times are generated automatically.</p>
      <button type="submit" disabled={pending}>
        {pending ? "Adding order..." : "Add order"}
      </button>
      {state.message && (
        <p
          className={state.status === "error" ? "form-message error" : "form-message"}
          role="status"
        >
          {state.message}
        </p>
      )}
    </form>
  );
}
