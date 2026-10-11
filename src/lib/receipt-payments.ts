import { usePayments } from "./data";
import { setReceiptPayments } from "./payments";

/** Keeps the receipts' payment lookup in step with the payments on screen.
 * Mount once, high in the app.
 *
 * The index is refreshed DURING render, not in an effect: receipts are built
 * in the render of the screens below this hook (for example bookingReceipt in
 * TurfTab), and an effect runs only after that render, so the first receipt
 * built right after a payment used the previous index and printed only the
 * advance (its mode split and note) next to the new paid total. Setting it is
 * a cheap, idempotent map rebuild, safe to repeat. */
export function useReceiptPaymentIndex() {
  const { data } = usePayments();
  setReceiptPayments(data);
}
