"use client";
import { useActionState } from "react";
import { registerDelivery, receiveDelivery, type DeliveryState } from "./actions";
import styles from "./page.module.css";
const initial: DeliveryState = { status: "idle", message: "" };

export function RegisterForm({ draftId, canWrite }: { draftId: string; canWrite: boolean }) {
  const [state, action, pending] = useActionState(registerDelivery, initial);
  return <form action={action} className={styles.form}>
    <input type="hidden" name="draftId" value={draftId} />
    <fieldset disabled={!canWrite || pending || state.status === "success"}>
      <label>Expected arrival date<input type="date" name="expected" required /></label>
      <label>Supplier order reference<input name="reference" maxLength={120} placeholder="e.g. supplier confirmation / PO number" required /></label>
      <label className={styles.check}><input type="checkbox" name="placed" value="yes" required />I have already placed this order with the supplier(s).</label>
      <button type="submit" className="primary-button">{pending ? "Registering…" : "Register expected delivery"}</button>
    </fieldset>
    {state.message && <p role="status" className={state.status === "error" ? styles.error : styles.success}>{state.message}</p>}
  </form>;
}
export function ReceiveForm({ id, remaining, unit, requestId, canWrite }: { id: string; remaining: string; unit: string; requestId: string; canWrite: boolean }) {
  const [state, action, pending] = useActionState(receiveDelivery, initial);
  return <form action={action} className={styles.form}>
    <input type="hidden" name="request" value={requestId} />
    <input type="hidden" name="delivery" value={id} />
    <input type="hidden" name="remaining" value={remaining} />
    <fieldset disabled={!canWrite || pending || state.status === "success"}>
      <label>Actual quantity received ({unit})<input type="number" name="amount" min="0.000001" max={remaining} step="0.000001" required placeholder={`Up to ${remaining} ${unit}`} /></label>
      <label>Delivery status<select name="arrival" required defaultValue="">
        <option value="" disabled>Choose delivery status</option>
        <option value="partial">More is coming</option>
        <option value="final">Final delivery</option>
      </select></label>
      <label>Delivery note / checked by<input name="note" required maxLength={120} placeholder="e.g. delivery note 42, checked by Siqi" /></label>
      <label className={styles.check}><input type="checkbox" name="received" value="yes" required />I checked the goods and quantities received.</label>
      <button type="submit" className="primary-button">{pending ? "Recording…" : "Confirm receipt & update stock"}</button>
    </fieldset>
    {state.message && <p role="status" className={state.status === "error" ? styles.error : styles.success}>{state.message}</p>}
  </form>;
}
