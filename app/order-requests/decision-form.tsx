"use client";

import { useActionState } from "react";
import { decideOrderRequestAction, type DecisionActionState } from "./actions";

const initialState: DecisionActionState = { status: "idle", message: "" };

export function DecisionForm({
  id,
  decision,
}: {
  id: string;
  decision: "approved" | "rejected";
}) {
  const [state, formAction, pending] = useActionState(
    decideOrderRequestAction.bind(null, id, decision),
    initialState,
  );
  const label = decision === "approved" ? "Approve order" : "Reject order";

  return (
    <form className="decision-form" action={formAction}>
      <label>
        Approver name
        <input name="approverName" maxLength={80} required />
      </label>
      <label>
        Decision note <span className="muted">(optional)</span>
        <input name="decisionNote" maxLength={500} />
      </label>
      {state.message && <p className="form-message error" role="status">{state.message}</p>}
      <button
        className={decision === "approved" ? "primary-button" : "reject-button"}
        type="submit"
        disabled={pending}
      >
        {pending ? "Saving..." : label}
      </button>
    </form>
  );
}
