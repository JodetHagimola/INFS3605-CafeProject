"use client";

import { useActionState, useEffect, useState } from "react";
import { decideOrderRequestAction, type DecisionActionState } from "./actions";
import { LoadingButton } from "../ui/feedback";

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
  const [submitted, setSubmitted] = useState(false);
  const label = decision === "approved" ? "Approve order" : "Reject order";

  useEffect(() => {
    if (!submitted || pending || state.message) return;
    const timeout = window.setTimeout(() => setSubmitted(false), 900);
    return () => window.clearTimeout(timeout);
  }, [pending, state.message, submitted]);

  return (
    <form className="decision-form" action={formAction} aria-busy={pending} onSubmit={() => setSubmitted(true)}>
      <label>
        Approver name
        <input name="approverName" maxLength={80} required />
      </label>
      <label>
        Decision note <span className="muted">(optional)</span>
        <input name="decisionNote" maxLength={500} />
      </label>
      {state.message && <p className="form-message error" role="status">{state.message}</p>}
      <LoadingButton
        className={decision === "approved" ? "primary-button" : "reject-button"}
        type="submit"
        busy={pending}
        busyLabel={decision === "approved" ? "Approving..." : "Rejecting..."}
        success={submitted && !pending && !state.message}
        successLabel={decision === "approved" ? "Approved" : "Rejected"}
      >
        {label}
      </LoadingButton>
    </form>
  );
}
