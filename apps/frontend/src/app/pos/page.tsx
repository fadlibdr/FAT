"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useDocuments } from "@/lib/meta-client";
import {
  type PosLine,
  type PosOrder,
  enqueue,
  flushQueue,
  loadQueue,
  submitOrder,
} from "@/lib/pos-queue";

function newId(): string {
  return `POS-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export default function PosPage() {
  const { data: itemData } = useDocuments("Item", { is_stock_item: "1" });
  const { data: customerData } = useDocuments("Customer");
  const items = itemData?.data ?? [];
  const customers = customerData?.data ?? [];

  const [cart, setCart] = useState<PosLine[]>([]);
  const [customer, setCustomer] = useState<string>("");
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    if (!customer && customers.length) setCustomer(String(customers[0].name));
  }, [customers, customer]);

  const refreshQueue = useCallback(() => setPending(loadQueue().length), []);

  const doFlush = useCallback(async () => {
    const { posted } = await flushQueue();
    refreshQueue();
    if (posted.length) setFlash(`Synced ${posted.length} queued order(s).`);
  }, [refreshQueue]);

  // Track connectivity and drain the queue whenever we come back online.
  useEffect(() => {
    refreshQueue();
    const sync = () => {
      const on = typeof navigator === "undefined" ? true : navigator.onLine;
      setOnline(on);
      if (on) void doFlush();
    };
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, [doFlush, refreshQueue]);

  const total = useMemo(() => cart.reduce((s, l) => s + l.amount, 0), [cart]);

  function addItem(code: string, name: string, rate: number) {
    setCart((c) => {
      const existing = c.find((l) => l.item_code === code);
      if (existing) {
        return c.map((l) =>
          l.item_code === code ? { ...l, qty: l.qty + 1, amount: (l.qty + 1) * l.rate } : l,
        );
      }
      return [...c, { item_code: code, item_name: name, qty: 1, rate, amount: rate }];
    });
  }

  function setQty(code: string, qty: number) {
    setCart((c) =>
      qty <= 0
        ? c.filter((l) => l.item_code !== code)
        : c.map((l) => (l.item_code === code ? { ...l, qty, amount: qty * l.rate } : l)),
    );
  }

  async function checkout() {
    if (!cart.length || !customer) return;
    const order: PosOrder = {
      id: newId(),
      customer,
      posting_date: new Date().toISOString().slice(0, 10),
      items: cart,
      total,
      grand_total: total,
    };
    setCart([]);
    const on = typeof navigator === "undefined" ? true : navigator.onLine;
    if (!on) {
      enqueue(order);
      refreshQueue();
      setFlash("Offline — order queued and will sync automatically.");
      return;
    }
    try {
      const invoice = await submitOrder(order);
      setFlash(`Paid — invoice ${invoice} posted.`);
    } catch {
      enqueue(order);
      refreshQueue();
      setFlash("Server unreachable — order queued for retry.");
    }
  }

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(t);
  }, [flash]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Point of Sale</h1>
          <p className="text-slate-500 text-sm">Ring up a sale — invoiced and paid in one tap.</p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-medium ${
              online ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${online ? "bg-emerald-500" : "bg-amber-500"}`}
            />
            {online ? "Online" : "Offline"}
          </span>
          {pending > 0 && (
            <button
              onClick={doFlush}
              className="rounded-full bg-slate-100 px-3 py-1 font-medium text-slate-700 hover:bg-slate-200"
            >
              {pending} queued — sync now
            </button>
          )}
        </div>
      </div>

      {flash && (
        <div className="rounded-lg border border-brand-200 bg-brand-50 px-4 py-2 text-sm text-brand-800">
          {flash}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Product grid */}
        <div className="lg:col-span-2">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {items.length === 0 && (
              <p className="col-span-full text-sm text-slate-400">No stock items to sell.</p>
            )}
            {items.map((it) => {
              const rate = Number(it.standard_rate ?? 0);
              return (
                <button
                  key={String(it.name)}
                  onClick={() =>
                    addItem(String(it.item_code ?? it.name), String(it.item_name ?? it.name), rate)
                  }
                  className="rounded-xl border border-slate-200 bg-white p-4 text-left transition hover:border-brand-300 hover:shadow-sm"
                >
                  <div className="font-medium text-slate-800">{String(it.item_name ?? it.name)}</div>
                  <div className="text-xs text-slate-400">{String(it.item_code ?? it.name)}</div>
                  <div className="mt-2 font-semibold text-brand-700">{money(rate)}</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Cart */}
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Customer
          </label>
          <select
            value={customer}
            onChange={(e) => setCustomer(e.target.value)}
            className="mt-1 mb-3 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            {customers.map((c) => (
              <option key={String(c.name)} value={String(c.name)}>
                {String(c.customer_name ?? c.name)}
              </option>
            ))}
          </select>

          <div className="divide-y divide-slate-100">
            {cart.length === 0 && <p className="py-6 text-center text-sm text-slate-400">Cart is empty.</p>}
            {cart.map((l) => (
              <div key={l.item_code} className="flex items-center gap-2 py-2">
                <div className="flex-1">
                  <div className="text-sm font-medium">{l.item_name ?? l.item_code}</div>
                  <div className="text-xs text-slate-400">{money(l.rate)} each</div>
                </div>
                <input
                  type="number"
                  min={0}
                  value={l.qty}
                  onChange={(e) => setQty(l.item_code, Number(e.target.value))}
                  className="w-14 rounded border border-slate-300 px-1.5 py-1 text-right text-sm"
                />
                <div className="w-16 text-right text-sm font-medium">{money(l.amount)}</div>
              </div>
            ))}
          </div>

          <div className="mt-3 flex items-center justify-between border-t border-slate-200 pt-3">
            <span className="font-semibold">Total</span>
            <span className="text-lg font-bold text-slate-800">{money(total)}</span>
          </div>
          <button
            onClick={checkout}
            disabled={!cart.length || !customer}
            className="mt-3 w-full rounded-lg bg-brand-600 py-2.5 font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Charge {money(total)}
          </button>
        </div>
      </div>
    </div>
  );
}
