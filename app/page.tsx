import { getOrders } from "@/lib/supabase/server";
import { OrderForm } from "./order-form";

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const result = await getOrders();

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="wordmark" href="/" aria-label="Cafe Inventory home">
          <span className="wordmark-mark" aria-hidden="true">C</span>
          <span>Cafe Inventory</span>
        </a>
        <span className="topbar-note">Order book</span>
      </header>

      <section className="orders-section" aria-labelledby="orders-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">DAILY OPERATIONS</p>
            <h1 id="orders-title">Orders</h1>
            <p className="section-description">Your most recent orders, first.</p>
          </div>
          {!result.error && (
            <p className="order-count">
              <strong>{result.orders.length}</strong>
              <span>{result.orders.length === 1 ? "order" : "orders"}</span>
            </p>
          )}
        </div>

        <OrderForm />

        {result.error ? (
          <div className="notice" role="status">
            <span className="notice-mark" aria-hidden="true">!</span>
            <p>{result.error}</p>
          </div>
        ) : result.orders.length === 0 ? (
          <div className="empty-state">
            <p className="empty-title">No orders yet</p>
            <p>When an order is added to Supabase, it will appear here.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Order ID</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {result.orders.map((order) => (
                  <tr key={String(order.id)}>
                    <td className="order-id">{order.id}</td>
                    <td>
                      {order.created_at ? (
                        <time dateTime={order.created_at}>
                          {new Date(order.created_at).toLocaleString()}
                        </time>
                      ) : (
                        <span className="muted">Not available</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="sort-note">Sorted by creation time, newest to oldest</p>
      </section>
    </main>
  );
}
