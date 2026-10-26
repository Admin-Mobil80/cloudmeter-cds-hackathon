import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../shared/ddb';
import {
  Caller, resolveCaller, json, requireWritable, requireNotDemo, canManageAccount,
} from '../../shared/authz';
import { loadAccountForCaller } from '../../shared/accounts';
import { persistMonthlySnapshots } from '../../shared/persist-cost';
import {
  AdhocItem, adhocSnapshots, chargedIn, currentMonthSpend, needsReview, needsCheckIn,
  isSubscriber, hasEnded,
} from '../../shared/adhoc';
import { monthKeyOf } from '../../shared/providers/types';

const MONTHS = 6;
const MAX_ITEMS = 100;
const MAX_NAME_LENGTH = 80;
const MAX_SUBSCRIBERS = 50;

/**
 * The subscriptions inside an "Adhoc Spend" account — read, add, edit, remove.
 *
 * There is no provider to poll, so this route is also the sync: every write
 * recomputes the six-month window from the items and stores it, which is the
 * only moment those numbers can change. The sweep skips these accounts
 * entirely (it processes `dataSource: 'live'`).
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Incoming {
  name?: unknown;
  type?: unknown;
  amount?: unknown;
  cadence?: unknown;
  subscribers?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
  note?: unknown;
  /** What was paid, and in what, where that is not USD. See validate(). */
  paidAmount?: unknown;
  paidCurrency?: unknown;
  paidRate?: unknown;
}

/** Returns the cleaned item, or a message naming what is wrong with it. */
function validate(body: Incoming, id: string): AdhocItem | string {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return 'Give the subscription a name.';
  if (name.length > MAX_NAME_LENGTH) return `Name must be ${MAX_NAME_LENGTH} characters or fewer`;

  const type = body.type === 'shared' ? 'shared' : 'individual';

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount < 0) return 'Cost must be a number, and cannot be negative.';
  // Not a hard technical limit — a guard against a typo that would swamp every
  // chart it lands in and be blamed on the cloud bill.
  if (amount > 1_000_000) return 'That cost looks wrong — check the figure.';

  const cadence = body.cadence === 'yearly' ? 'yearly' : 'monthly';

  const rawSubs = Array.isArray(body.subscribers) ? body.subscribers : [];
  const subscribers = rawSubs
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean)
    .slice(0, MAX_SUBSCRIBERS);

  const startsAt = typeof body.startsAt === 'string' ? body.startsAt.trim() : '';
  if (!ISO_DATE.test(startsAt)) return 'Enter a start date.';

  const endsRaw = typeof body.endsAt === 'string' ? body.endsAt.trim() : '';
  const endsAt = endsRaw ? endsRaw : null;
  if (endsAt && !ISO_DATE.test(endsAt)) return 'That end date is not a valid date.';
  // Caught here rather than silently producing a line that is never charged in
  // any month and looks, on screen, exactly like one that is.
  if (endsAt && endsAt < startsAt) return 'The end date cannot be before the start date.';

  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : null;

  /*
   * What was actually paid, where it was paid in something other than USD.
   *
   * `amount` stays the USD equivalent so every roll-up keeps working, but the
   * paid figure is what the card shows — converting it back for display is
   * how a fixed ₹1,999 subscription started drifting with the exchange rate.
   *
   * The rate is taken on trust from the request only in the sense that the
   * page got it from /me, which resolved it server-side; it is stored so the
   * arithmetic can be checked later rather than inferred.
   */
  const paidCurrency = typeof body.paidCurrency === 'string' ? body.paidCurrency.trim().toUpperCase() : '';
  const paidAmountRaw = Number(body.paidAmount);
  const paidRateRaw = Number(body.paidRate);
  const paid = paidCurrency && paidCurrency !== 'USD'
    && Number.isFinite(paidAmountRaw) && paidAmountRaw >= 0
    && Number.isFinite(paidRateRaw) && paidRateRaw > 0;

  if (paid && paidAmountRaw > 1_000_000_000) return 'That cost looks wrong — check the figure.';

  // Stamped on every write: any create or edit is someone confirming this
  // line, which is what the check-in prompt measures from.
  return { id, name, type, subscribers, amount, cadence, startsAt, endsAt, note,
    ...(paid ? { paidAmount: paidAmountRaw, paidCurrency, paidRate: paidRateRaw } : {}),
    updatedAt: new Date().toISOString() };
}

function itemsOf(account: { adhocItems?: unknown }): AdhocItem[] {
  const raw = account.adhocItems;
  return Array.isArray(raw) ? (raw as AdhocItem[]) : [];
}

function isMember(caller: Caller): boolean {
  return caller.membership.role === 'member';
}

/** Display name to user id, for everyone in the workspace. */
async function loadRoster(tenantId: string): Promise<Map<string, string>> {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ProjectionExpression: 'userId, #n',
    ExpressionAttributeNames: { '#n': 'name' },
    ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}`, ':sk': 'MEMBER#' },
  }));

  const byName = new Map<string, string>();
  for (const m of Items ?? []) {
    const name = typeof m.name === 'string' ? m.name.trim().toLowerCase() : '';
    // First writer wins, so two people sharing a display name cannot take each
    // other's lines by being read second. Neither gets the other's access: the
    // loser simply resolves to nobody, which reads as "not yours".
    if (name && typeof m.userId === 'string' && !byName.has(name)) byName.set(name, m.userId);
  }
  return byName;
}

/**
 * The workspace's display names, for a Member's subscriber picker.
 *
 * Separate from loadRoster, which maps name to userId for attribution. This
 * returns what a person is called, sorted, because it is going straight into a
 * list somebody reads.
 */
async function loadRosterNames(tenantId: string): Promise<string[]> {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ProjectionExpression: '#n, #s',
    ExpressionAttributeNames: { '#n': 'name', '#s': 'status' },
    ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}`, ':sk': 'MEMBER#' },
  }));

  const names = new Set<string>();
  for (const m of Items ?? []) {
    if (m.status === 'removed') continue;
    const name = typeof m.name === 'string' ? m.name.trim() : '';
    if (name) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/**
 * Decides who a line is for, which is never simply what the request said.
 *
 * Every name is matched against the workspace, so the stored ids are real and
 * an invented name cannot become a subscriber who is nobody.
 *
 * A Member may now name colleagues on a shared line — a subscription several
 * people use is a fact about several people, and forcing each of them to file
 * their own line for the same payment produced duplicates of one cost. What a
 * Member may not do is file a line they are not on: recording somebody else's
 * spending with no involvement of their own is the one case with no honest
 * reading, so they are always added to their own lines. requireMemberOnOwnLine
 * below refuses a submission that leaves them off.
 */
export function withSubscribers(
  item: AdhocItem,
  caller: Caller,
  roster: Map<string, string>,
): AdhocItem {
  /*
   * One row per person.
   *
   * The form refuses a repeated name with a message, which is the right place
   * for it: two rows for one person is usually the second one meant to be
   * somebody else, and only the person filling it in can say. This is the
   * backstop for everything that does not come from the form — a direct call,
   * an older page still cached — and it also quietly repairs a line already
   * stored with a duplicate the next time anyone edits it.
   *
   * The first spelling wins. Matched case- and space-insensitively, the same
   * comparison the head count and the roster lookup already use, so what is
   * stored agrees with what is counted.
   */
  const names: string[] = [];
  const seen = new Set<string>();
  for (const raw of item.subscribers) {
    const key = String(raw ?? '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    names.push(raw);
  }

  // A Member is always on their own line, whether or not the form said so.
  // Silently added rather than rejected: the alternative is refusing a
  // submission over something the server can simply make true.
  if (isMember(caller)) {
    const own = (caller.membership.name ?? '').trim();
    const already = names.some((n) => n.trim().toLowerCase() === own.toLowerCase());
    if (own && !already) names.push(own);
  }

  const ids = names
    .map((s) => roster.get(s.trim().toLowerCase()))
    .filter((id): id is string => !!id);

  return { ...item, subscribers: names, subscriberUserIds: [...new Set(ids)] };
}

/** Writes the items back and rebuilds the months they imply. */
async function save(tenantId: string, accountId: string, items: AdhocItem[]): Promise<void> {
  const now = new Date();
  const spend = currentMonthSpend(items, now);

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TENANT#${tenantId}`, SK: `ACCOUNT#${accountId}` },
    UpdateExpression: 'SET adhocItems = :items, spend = :spend, #sync = :now, updatedAt = :now',
    ExpressionAttributeNames: { '#sync': 'sync' },
    ExpressionAttributeValues: { ':items': items, ':spend': spend, ':now': now.toISOString() },
  }));

  await persistMonthlySnapshots(accountId, adhocSnapshots(items, MONTHS, now));
}

/**
 * What one caller is allowed to see of an account's subscriptions.
 *
 * Owners and Admins get the account whole — the roll-up is the point of their
 * view. A Member gets their own lines and nothing else: an adhoc account is a
 * shared ledger, and everything else in it is a colleague's spend.
 *
 * Every figure below is derived from this list rather than the full one, so
 * the totals a Member is shown describe what a Member can see. A count that
 * included lines missing from the list underneath it would be the one thing
 * worse than hiding them.
 */
function visibleTo(items: AdhocItem[], caller: Caller): AdhocItem[] {
  if (!isMember(caller)) return items;
  return items.filter((i) => isSubscriber(i, caller.userId));
}

function view(all: AdhocItem[], caller: Caller, rosterNames: string[] = []) {
  const items = visibleTo(all, caller);
  const now = new Date();
  const flagged = new Set(needsReview(items, now).map((i) => i.id));
  const thisMonth = monthKeyOf(now);
  const stale = new Set(items.filter((i) => needsCheckIn(i, now)).map((i) => i.id));
  return {
    // `chargedThisMonth` is sent alongside `needsReview` because they answer
    // different questions and can disagree: a subscription running to the 25th
    // is still live, but if it was paid in August then September's figure
    // rightly carries none of it. Without this the UI has to guess, and the
    // only wrong guess available is telling someone a running subscription
    // has ended.
    items: items.map((i) => ({
      ...i,
      needsReview: flagged.has(i.id),
      // Open-ended and untouched for months: still charging, and nobody has
      // confirmed it in a long time. Distinct from needsReview, which is about
      // an end date that has passed.
      needsCheckIn: stale.has(i.id),
      chargedThisMonth: chargedIn(i, thisMonth),
      // So the card can hide an Edit that would 403. The server decides it
      // again on the write; this only keeps the UI from offering it.
      canEdit: !isMember(caller) || isSubscriber(i, caller.userId),
    })),
    monthlyTotal: currentMonthSpend(items),
    reviewCount: flagged.size,
    checkInCount: stale.size,
    /*
     * Whether this response is one person's slice or the whole account.
     *
     * The card needs to know, because the difference is not visible in the
     * numbers: a Member seeing one line and $20 cannot tell that from an
     * account that genuinely holds one line. It drives the wording, and it is
     * why the tiles and the six-month chart are hidden from a Member — those
     * are built from the account's stored totals, which are the whole team's.
     */
    scoped: isMember(caller),
    /** The name a Member's own new line will be filed under. */
    youAre: isMember(caller) ? ((caller.membership.name ?? '').trim() || null) : null,
    /*
     * The workspace's names, for the subscriber picker.
     *
     * A Member cannot read /team — requireOrgScope refuses them — so without
     * this they had no list to choose from and could only ever record a line
     * for themselves. Sent from here rather than by relaxing /team, because
     * the need is narrow: names to attribute a shared subscription, not the
     * emails, roles and invitations /team also carries.
     *
     * Only for a Member. Everyone else already fetches /team for this.
     */
    teamNames: isMember(caller) ? rosterNames : null,
  };
}

export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const caller = await resolveCaller(event);
  if (!caller) return json(404, { message: 'No tenant membership found' });

  const accountId = event.pathParameters?.accountId;
  if (!accountId) return json(400, { message: 'accountId is required' });

  // The one route that may open an adhoc account to anyone in the workspace:
  // it filters per line below, which is what makes that safe.
  const account = await loadAccountForCaller(caller, accountId, { sharedAdhoc: true });
  if (!account) return json(404, { message: 'Account not found' });
  if (account.provider !== 'adhoc') {
    return json(400, { message: 'That account does not hold adhoc subscriptions.' });
  }

  const method = event.requestContext.http.method;
  const items = itemsOf(account as { adhocItems?: unknown });

  // Reading is open to anyone who can see the account — filtered to their own
  // lines for a Member. See visibleTo().
  if (method === 'GET') {
    // A Member needs the workspace's names to attribute a shared line; nobody
    // else does, because everyone else can read /team. Loaded only for them so
    // an Owner's page view costs no extra query.
    const names = isMember(caller)
      ? await loadRosterNames(caller.membership.tenantId)
      : [];
    return json(200, view(items, caller, names));
  }

  const readOnly = requireWritable(caller) ?? requireNotDemo(caller);
  if (readOnly) return readOnly;

  /*
   * Who may write here.
   *
   * Owners and Admins: any line, as before. A Member: their own, and only
   * their own — the point of the feature is that people record what they are
   * paying for themselves rather than queueing behind an Admin.
   *
   * There is deliberately no account-level bar for a Member any more. The
   * check that matters is per line and happens below, because "may this person
   * write to this account" is the wrong question when the account is a shared
   * ledger of everyone's subscriptions.
   */
  const member = isMember(caller);
  if (!member && !canManageAccount(caller, account as { createdBy?: string })) {
    return json(403, { message: 'Only an Owner or Admin can change subscriptions.' });
  }

  let body: Incoming;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { message: 'Invalid JSON body' });
  }

  const tenantId = caller.membership.tenantId;
  const itemId = event.pathParameters?.itemId;
  // Loaded for everyone now. A Member's names used to be discarded, so there
  // was nothing to resolve; now they may name colleagues, and an unresolved
  // name would store a subscriber attributed to nobody.
  const roster = await loadRoster(tenantId);

  /** A Member may touch only a line they are named on. */
  const mayChange = (item: AdhocItem) => !member || isSubscriber(item, caller.userId);
  const notYours = json(403, { message: 'You can only change your own subscriptions.' });

  if (method === 'POST') {
    if (items.length >= MAX_ITEMS) {
      return json(400, { message: `An account can hold ${MAX_ITEMS} subscriptions.` });
    }
    const result = validate(body, randomUUID());
    if (typeof result === 'string') return json(400, { message: result });

    const next = [...items, withSubscribers(result, caller, roster)];
    await save(tenantId, accountId, next);
    return json(201, view(next, caller));
  }

  if (method === 'PATCH') {
    if (!itemId) return json(400, { message: 'itemId is required' });
    const existing = items.find((i) => i.id === itemId);
    if (!existing) return json(404, { message: 'Subscription not found' });
    // Judged on the line as it stands, never on the incoming body: otherwise a
    // Member could name themselves on somebody else's line and edit it.
    if (!mayChange(existing)) return notYours;

    const result = validate(body, itemId);
    if (typeof result === 'string') return json(400, { message: result });

    /*
     * A finished subscription keeps the start date it was paid on.
     *
     * Moving it rewrites which months were charged, for a period that is over
     * and already reported — the six-month chart, the account total and any
     * digest sent since would all disagree with each other. Extending the end
     * date is the honest edit for a subscription that renewed; a different
     * start date is a different subscription, and should be added as one.
     */
    if (hasEnded(existing) && result.startsAt !== existing.startsAt) {
      return json(400, {
        message: 'This subscription has ended, so its start date is fixed. '
          + 'Change the end date to extend it, or add a new subscription for a new period.',
      });
    }

    const next = items.map((i) => (i.id === itemId ? withSubscribers(result, caller, roster) : i));
    await save(tenantId, accountId, next);
    return json(200, view(next, caller));
  }

  if (method === 'DELETE') {
    if (!itemId) return json(400, { message: 'itemId is required' });
    const existing = items.find((i) => i.id === itemId);
    if (!existing) return json(404, { message: 'Subscription not found' });
    if (!mayChange(existing)) return notYours;

    const next = items.filter((i) => i.id !== itemId);

    // Removing a line rewrites history rather than leaving its cost stranded in
    // past months: the customer has said this was never theirs to pay.
    await save(tenantId, accountId, next);
    return json(200, view(next, caller));
  }

  return json(405, { message: `${method} not supported here` });
};
