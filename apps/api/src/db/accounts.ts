import type { Db } from '../db/types.js';
import { getSql } from './client.js';

/**
 * Chart of accounts.
 *
 * Decision (brief was silent): the platform fee is booked as *revenue*, and
 * the cash sitting at the gateway is an *asset*. Escrow for a seller is a
 * liability of the platform towards that seller, split by state:
 *
 *   asset:gateway_cash           money we hold at the payment gateway
 *   liability:user:{id}:pending  money owed to the seller but still escrowed
 *   liability:user:{id}:available money the seller may withdraw
 *   revenue:platform_fee         fees kept by the platform
 *
 * Balances are never stored; they are derived from ledger_entries.
 */

export const ACCOUNT_CODES = {
  gatewayCash: 'asset:gateway_cash',
  platformFee: 'revenue:platform_fee',
  refundPayable: 'liability:refund_payable',
} as const;

export function pendingAccountCode(userId: string): string {
  return `liability:user:${userId}:pending`;
}

export function availableAccountCode(userId: string): string {
  return `liability:user:${userId}:available`;
}

export interface AccountRow {
  id: string;
  code: string;
  kind: string;
  owner_user_id: string | null;
  name: string;
}

export async function ensurePlatformAccounts(sql: Db): Promise<void> {
  await sql`
    INSERT INTO ledger_accounts (code, kind, name)
    VALUES
      (${ACCOUNT_CODES.gatewayCash}, 'asset', 'Tien tai cong thanh toan'),
      (${ACCOUNT_CODES.platformFee}, 'revenue', 'Phi dich vu cua san'),
      (${ACCOUNT_CODES.refundPayable}, 'liability', 'Tien phai hoan cho nguoi mua')
    ON CONFLICT (code) DO NOTHING
  `;
}

export async function ensureUserAccounts(sql: Db, userId: string, userName: string): Promise<void> {
  await sql`
    INSERT INTO ledger_accounts (code, kind, owner_user_id, name)
    VALUES
      (${pendingAccountCode(userId)}, 'liability', ${userId}, ${`Tien cho giai ngan - ${userName}`}),
      (${availableAccountCode(userId)}, 'liability', ${userId}, ${`Tien kha dung - ${userName}`})
    ON CONFLICT (code) DO NOTHING
  `;
}

export async function getAccountByCode(sql: Db, code: string): Promise<AccountRow | undefined> {
  const rows = await sql<AccountRow[]>`
    SELECT id, code, kind, owner_user_id, name
    FROM ledger_accounts
    WHERE code = ${code}
    LIMIT 1
  `;
  return rows[0];
}

export async function getAccountsByCodes(sql: Db, codes: string[]): Promise<AccountRow[]> {
  if (codes.length === 0) return [];
  const rows = await sql<AccountRow[]>`
    SELECT id, code, kind, owner_user_id, name
    FROM ledger_accounts
    WHERE code IN ${sql(codes)}
  `;
  return rows;
}

export async function listAccounts(sql: Db = getSql()): Promise<AccountRow[]> {
  const rows = await sql<AccountRow[]>`
    SELECT id, code, kind, owner_user_id, name
    FROM ledger_accounts
    ORDER BY code
  `;
  return rows;
}
