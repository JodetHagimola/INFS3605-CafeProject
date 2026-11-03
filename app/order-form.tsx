"use client";

import { useActionState, useEffect, useState } from "react";
import { createOrderAction, type CreateOrderState } from "./actions";
import { LoadingButton } from "./ui/feedback";

const initialState: CreateOrderState = { message: "", status: "idle" };

export function OrderForm() {
  const [state, formAction, pending] = useActionState(
    createOrderAction,
    initialState,
  );
  const [justAdded, setJustAdded] = useState(false);

  useEffect(() => {
    if (state.status !== "success") return;
    setJustAdded(true);
    const timeout = window.setTimeout(() => setJustAdded(false), 900);
    return () => window.clearTimeout(timeout);
  }, [state]);

  return (
    <form className="order-form" action={formAction} aria-busy={pending}>
      <p>Order IDs and creation times are generated automatically.</p>
      <LoadingButton type="submit" busy={pending} busyLabel="Adding order..." success={justAdded && !pending} successLabel="Added">
        Add order
      </LoadingButton>
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
