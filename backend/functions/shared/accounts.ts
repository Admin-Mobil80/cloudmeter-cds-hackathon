import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb';
import { Caller, canViewAccount } from './authz';

export interface CloudAccountItem {
  accountId: string;
  provider: string;
  name: string;
  externalId: string;
  status: string;
  /**
   * The whole account's current month.
   *
   * On an adhoc account that is every subscription in it, which is not what a
   * Member may be shown — see ownMonthSpend(). Routes that answer a Member
   * narrow this before returning it.
   */
  spend: number;
  sync: string;
  createdAt: string;
  /** Present on adhoc accounts only: the hand-entered subscriptions. */
  adhocItems?: unknown;
  /**
   * 'live'  = real provider cost data, pulled by the sweep;
   * 'seed'  = generated sample data;
   * 'adhoc' = typed in by hand, with nothing to poll.
   *
   * 'adhoc' was added with the Adhoc Spend provider and written by
   * accounts/create, but this type was never widened to match — so anything
   * reading it back was told the case could not occur.
   */
  dataSource?: 'live' | 'seed' | 'adhoc';
  /**
   * Who is answerable for this account, and therefore who may manage it.
   * Starts as whoever connected it, but is reassignable — people leave, and an
   * account whose only non-Owner manager has gone is otherwise stranded.
   * Absent on accounts added before this was recorded, which is treated as
   * "unknown", not "yours" — an Admin can't claim one by default.
   */
  createdBy?: string;
  createdByEmail?: string;
  /** Set the first time createdBy is reassigned, so the original fact survives. */
  connectedBy?: string;
  connectedByEmail?: string;
  /** Who last reassigned it, and when. */
  createdByUpdatedAt?: string;
  createdByUpdatedBy?: string;
  /**
   * 'self' (default) counts only this account's own spend. 'organization'
   * counts every account beneath it, for a payer connected on its own.
   */
  costScope?: 'self' | 'organization';
  /**
   * Who to talk to about this account's spend. Free text and optional — often
   * a team alias rather than a person, and deliberately not pulled from the
   * provider: an AWS root email is a phishing target and only exists for org
   * members anyway.
   */
  owner?: string;
  /** Secrets Manager ARN holding this account's provider credentials. */
  credentialsSecretArn?: string;
  /** Legacy inline AWS fields, predating the move to Secrets Manager. */
  roleArn?: string;
  assumeRoleExternalId?: string;
  lastSyncError?: string;
}

// MONTHLY# snapshot items are keyed by ACCOUNT#<id> only (not tenant-scoped
// in the key itself), so every cost-data handler must verify the account
// belongs to the caller's own tenant before it queries or returns anything
// for that accountId — this is that check.
//
// Prefer loadAccountForCaller() in request handlers: it applies the caller's
// per-account scope as well. This lower-level form is for background jobs,
// which have no caller.
export async function verifyAccountOwnership(tenantId: string, accountId: string): Promise<CloudAccountItem | null> {
  const { Item } = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TENANT#${tenantId}`, SK: `ACCOUNT#${accountId}` },
  }));
  return (Item as CloudAccountItem) ?? null;
}

/**
 * Loads an account for a request, enforcing both tenant ownership and the
 * caller's own scope.
 *
 * A Member mapped to other accounts is told the account doesn't exist rather
 * than that they can't see it — whether a given account id is real is itself
 * information they aren't entitled to.
 */
export async function loadAccountForCaller(
  caller: Caller,
  accountId: string,
  opts: { sharedAdhoc?: boolean } = {},
): Promise<CloudAccountItem | null> {
  const account = await verifyAccountOwnership(caller.membership.tenantId, accountId);
  if (!account) return null;

  /*
   * Adhoc accounts are open to the whole workspace — but only where the caller
   * has asked for that, and only where the route can handle it.
   *
   * The per-account mapping exists so a Member sees only the cloud bills they
   * are answerable for. An adhoc account is not one bill: it is a shared ledger
   * of everybody's subscriptions to one tool, and a Member has to reach it to
   * record their own. Gating it per account would mean an Admin mapping every
   * member to every tool by hand before anyone could type anything in.
   *
   * Opt-in rather than automatic, because reaching the account is not the same
   * as being allowed everything inside it. Only three callers pass this: the
   * list, the account read, and the adhoc-items route that does the per-line
   * filtering. The cost routes deliberately do not — they answer with totals
   * for the whole account, which for a Member would be their colleagues'
   * spend arriving by a side door while the page politely hid it.
   */
  if (opts.sharedAdhoc && account.provider === 'adhoc') return account;

  if (!canViewAccount(caller, accountId)) return null;
  return account;
}
