"use client";

import { useActionState, useEffect, useState } from "react";
import { submitOrderRequest, type OrderRequestActionState } from "./actions";

type ItemFields = { key: number };
const initialState: OrderRequestActionState = { status: "idle", message: "", resetVersion: 0 };

export function OrderRequestForm() {
  const [state, formAction, pending] = useActionState(submitOrderRequest, initialState);
  const [items, setItems] = useState<ItemFields[]>([{ key: 0 }]);
  const [nextKey, setNextKey] = useState(1);

  useEffect(() => {
    if (state.resetVersion > 0) {
      setItems([{ key: state.resetVersion * 20 }]);
      setNextKey(state.resetVersion * 20 + 1);
    }
  }, [state.resetVersion]);

  function addItem() {
    if (items.length >= 20) return;
    setItems([...items, { key: nextKey }]);
    setNextKey(nextKey + 1);
  }

  function removeItem(key: number) {
    if (items.length > 1) setItems(items.filter((item) => item.key !== key));
  }

  return (
    <form className="request-form" action={formAction}>
      <div className="request-form-grid">
        <label>
          Chef name
          <input name="chefName" autoComplete="name" maxLength={80} required />
        </label>
        <label>
          Needed by
          <input
            name="neededBy"
            type="date"
            min={new Date().toISOString().slice(0, 10)}
            required
          />
        </label>
      </div>

      <fieldset className="request-items">
        <legend>Items to order</legend>
        {items.map((item, index) => (
          <div className="request-item-row" key={item.key}>
            <label>
              Item
              <input name="itemName" maxLength={100} placeholder="e.g. Oat milk" required={index === 0} />
            </label>
            <label>
              Quantity
              <input
                name="itemQuantity"
                type="number"
                min="0.001"
                max="1000000"
                step="0.001"
                placeholder="e.g. 6"
                required={index === 0}
              />
            </label>
            <label>
              Unit
              <input name="itemUnit" maxLength={30} placeholder="e.g. cartons" required={index === 0} />
            </label>
            {items.length > 1 && (
              <button
                className="remove-item-button"
                type="button"
                onClick={() => removeItem(item.key)}
                aria-label={`Remove item ${index + 1}`}
              >
                Remove
              </button>
            )}
          </div>
        ))}
        <button className="text-button" type="button" onClick={addItem} disabled={items.length >= 20}>
          + Add another item
        </button>
      </fieldset>

      <label>
        Notes <span className="muted">(optional)</span>
        <textarea name="notes" maxLength={500} rows={3} placeholder="Supplier preference or other details" />
      </label>

      {state.message && (
        <p className={`form-message${state.status === "error" ? " error" : ""}`} role="status">
          {state.message}
        </p>
      )}
      <button className="primary-button" type="submit" disabled={pending}>
        {pending ? "Submitting..." : "Submit for approval"}
      </button>
    </form>
  );
}
