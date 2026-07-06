import { api } from "./api-client";

export interface PosLine {
  item_code: string;
  item_name?: string;
  qty: number;
  rate: number;
  amount: number;
}

export interface PosOrder {
  /** Client-generated id so a queued order survives reloads and can be deduped. */
  id: string;
  customer: string;
  posting_date: string;
  items: PosLine[];
  total: number;
  grand_total: number;
  /** Set once the order has been posted to the server. */
  invoice?: string;
}

const QUEUE_KEY = "fat_pos_queue";

export function loadQueue(): PosOrder[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as PosOrder[]) : [];
  } catch {
    return [];
  }
}

export function saveQueue(queue: PosOrder[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export function enqueue(order: PosOrder): PosOrder[] {
  const queue = loadQueue();
  queue.push(order);
  saveQueue(queue);
  return queue;
}

export function dequeue(id: string): PosOrder[] {
  const queue = loadQueue().filter((o) => o.id !== id);
  saveQueue(queue);
  return queue;
}

/**
 * Post an order to the server: create + submit a Sales Invoice, then a matching
 * Payment Entry (Receive) reconciled against it. `order.invoice` is stamped after
 * the invoice is created so a retry that failed mid-sequence resumes at payment
 * instead of duplicating the invoice.
 */
export async function submitOrder(order: PosOrder): Promise<string> {
  let invoiceName = order.invoice;
  if (!invoiceName) {
    const inv = await api.post<{ data: { name: string } }>("/api/resource/Sales Invoice", {
      customer: order.customer,
      posting_date: order.posting_date,
      currency: "USD",
      conversion_rate: 1,
      items: order.items.map((l) => ({
        item_code: l.item_code,
        qty: l.qty,
        rate: l.rate,
        amount: l.amount,
      })),
      total: order.total,
      grand_total: order.grand_total,
    });
    invoiceName = inv.data.name;
    order.invoice = invoiceName;
    // Persist the invoice name immediately in case submit/payment fails.
    saveQueue(loadQueue().map((o) => (o.id === order.id ? { ...o, invoice: invoiceName } : o)));
    await api.post(`/api/resource/Sales Invoice/${encodeURIComponent(invoiceName)}/submit`);
  }

  const pay = await api.post<{ data: { name: string } }>("/api/resource/Payment Entry", {
    payment_type: "Receive",
    posting_date: order.posting_date,
    party: order.customer,
    paid_amount: order.grand_total,
    currency: "USD",
    conversion_rate: 1,
    reference_no: order.id,
    references: [
      {
        reference_doctype: "Sales Invoice",
        reference_name: invoiceName,
        allocated_amount: order.grand_total,
      },
    ],
  });
  await api.post(`/api/resource/Payment Entry/${encodeURIComponent(pay.data.name)}/submit`);
  return invoiceName;
}

/**
 * Flush every queued order in FIFO order. Stops at the first failure so ordering
 * is preserved and the caller can retry later. Returns the invoices posted.
 */
export async function flushQueue(): Promise<{ posted: string[]; remaining: number }> {
  const posted: string[] = [];
  let queue = loadQueue();
  for (const order of [...queue]) {
    try {
      const invoice = await submitOrder(order);
      posted.push(invoice);
      queue = dequeue(order.id);
    } catch {
      break; // keep this and later orders queued; preserve FIFO order
    }
  }
  return { posted, remaining: queue.length };
}
