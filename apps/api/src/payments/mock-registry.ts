/**
 * The transactions the *mock gateway* knows about.
 *
 * A payment gateway remembers every transaction it has accepted, and it
 * can be asked about them later (`querydr`). That is the second source of
 * truth the app uses to recover a lost notification.
 *
 * The mock used to have no such memory: the payment page signed the
 * payload and called the IPN endpoint directly, so the mock gateway only
 * ever existed inside the browser tab. The lost-IPN fallback could
 * therefore not be exercised at all in the default (`MOCK_GATEWAY=true`)
 * setup - the button was a dead end, and the branch had no test.
 *
 * So the mock keeps a registry: the payment page *registers* the
 * transaction with the gateway first (which is what a real gateway does
 * when the buyer confirms), and only then notifies the app. If the
 * notification is lost, the gateway still knows about the payment and can
 * be asked - exactly like the real thing.
 *
 * The registry is in memory on purpose: it is a development aid, it
 * disappears when the process exits, and it never holds real money.
 */

/** A payment the mock gateway has accepted. */
export interface MockTransaction {
  /** the `vnp_TxnRef` the payment was created with */
  gatewayRef: string;
  /** the amount in VND (the wire value is this multiplied by 100) */
  amountVnd: number;
  /** the gateway's own transaction number */
  transactionNo: string;
  /** '00' when the payment succeeded */
  status: string;
  /** when the payment was created */
  createdAt: Date;
}

const transactions = new Map<string, MockTransaction>();

/**
 * Records a payment the mock gateway has accepted.
 *
 * A second registration for the same reference replaces the first one,
 * so a buyer who retries the payment does not end up with two rows.
 */
export function recordMockTransaction(txn: MockTransaction): void {
  transactions.set(txn.gatewayRef, txn);
}

/**
 * The payment the gateway knows about for this reference, if any.
 *
 * `undefined` means the gateway has never seen the payment - which is
 * what the real gateway answers with `91` ("not found").
 */
export function findMockTransaction(gatewayRef: string): MockTransaction | undefined {
  return transactions.get(gatewayRef);
}

/** Forgets every payment. Only used by the tests. */
export function clearMockTransactions(): void {
  transactions.clear();
}
