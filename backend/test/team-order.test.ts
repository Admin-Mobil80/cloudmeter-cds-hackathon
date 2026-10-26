/**
 * The order the Team page lists people in.
 *
 * It was owner first and everyone else oldest-joined first, which mirrored how
 * the workspace grew. At eight people that reads fine. Mobil80 has thirty-one
 * and thirteen pending invites, and join order is invisible on screen — so the
 * list simply looked unsorted, and finding one person meant reading every row.
 *
 * Now: Owner, then Admins, then Members, alphabetical by name inside each
 * group.
 */

import { byRoleThenName } from '../functions/api/team/list';

type Row = { role?: unknown; name?: unknown; email?: unknown };

/** Drives the real comparator, rather than a copy of its rules. */
const order = (rows: Row[]) => [...rows].sort(byRoleThenName).map((r) => r.name ?? r.email);

const p = (name: string, role: string, email = `${name.split(' ')[0].toLowerCase()}@mobil80.com`): Row =>
  ({ name, role, email });

describe('role comes first', () => {
  it('puts the Owner above everyone, whatever their name', () => {
    // Rohan is the owner and sorts late alphabetically; the role has to win.
    expect(order([
      p('Aditya', 'member'),
      p('Rohan Rahman', 'owner'),
      p('Ravi Pal', 'admin'),
    ])).toEqual(['Rohan Rahman', 'Ravi Pal', 'Aditya']);
  });

  it('puts every Admin above every Member', () => {
    expect(order([
      p('Asha', 'member'),
      p('Zain Habib', 'admin'),
      p('Bala', 'member'),
      p('Mohan Kumar K', 'admin'),
    ])).toEqual(['Mohan Kumar K', 'Zain Habib', 'Asha', 'Bala']);
  });

  it('sorts an unrecognised role to the bottom, not the top', () => {
    /*
     * The failure direction that matters. A role this code has not been told
     * about — added server-side later, or a typo in a stored record — must not
     * land above the owner, where it would read as the person in charge.
     */
    expect(order([
      p('Someone', 'auditor'),
      p('Rohan Rahman', 'owner'),
      p('Zoya', 'member'),
    ])).toEqual(['Rohan Rahman', 'Zoya', 'Someone']);
  });
});

describe('then name, as an alphabet', () => {
  it('orders names inside a role', () => {
    expect(order([
      p('Radhika', 'member'),
      p('Chandana', 'member'),
      p('Karthick', 'member'),
    ])).toEqual(['Chandana', 'Karthick', 'Radhika']);
  });

  it('ignores case, so a lowercase name is not exiled to the end', () => {
    // Mobil80 has a member stored as "reena". Compared byte by byte, every
    // lowercase name sorts after every capitalised one — which is exactly the
    // unsorted-looking list this change exists to fix.
    expect(order([
      p('Zain Habib', 'member'),
      p('reena', 'member'),
      p('Asha', 'member'),
    ])).toEqual(['Asha', 'reena', 'Zain Habib']);
  });

  it('sorts accented names where a reader expects them', () => {
    expect(order([
      p('Zoya', 'member'),
      p('Ángela', 'member'),
      p('Bala', 'member'),
    ])).toEqual(['Ángela', 'Bala', 'Zoya']);
  });

  it('ignores padding around a stored name', () => {
    expect(order([
      p('Bala', 'member'),
      { name: '  Asha ', role: 'member', email: 'asha@mobil80.com' },
    ])).toEqual(['  Asha ', 'Bala']);
  });
});

describe('rows that are missing something', () => {
  it('falls back to the email when there is no name', () => {
    // A pending invite can arrive without a name. Sorting it by an empty
    // string would park it at the top of its role, above everybody.
    const rows: Row[] = [
      p('Bala', 'member'),
      { role: 'member', email: 'zz@mobil80.com' },
      p('Asha', 'member'),
    ];
    expect(order(rows)).toEqual(['Asha', 'Bala', 'zz@mobil80.com']);
  });

  it('breaks a tie on email, so two of one name keep a stable order', () => {
    // Display names are not unique. Without a tiebreak the pair would come
    // back in whatever order the query produced, and could swap between
    // refreshes for no visible reason.
    const rows: Row[] = [
      { name: 'Kumar', role: 'member', email: 'kumar.b@mobil80.com' },
      { name: 'Kumar', role: 'member', email: 'kumar.a@mobil80.com' },
    ];
    expect(order(rows).join()).toBe('Kumar,Kumar');
    expect([...rows].sort(byRoleThenName).map((r) => r.email))
      .toEqual(['kumar.a@mobil80.com', 'kumar.b@mobil80.com']);
  });

  it('does not throw on a row with neither name nor email', () => {
    expect(() => order([{ role: 'member' }, p('Asha', 'member')])).not.toThrow();
  });
});

describe('the whole Mobil80 roster, as it will now read', () => {
  it('groups by role and alphabetises inside each', () => {
    // A real slice of the workspace in the screenshot, deliberately shuffled.
    const roster: Row[] = [
      p('Kevin Philip', 'member'),
      p('Mohan Kumar K', 'admin'),
      p('Rohan Rahman', 'owner'),
      p('Kanagala Lokesh Kumar', 'member'),
      p('Neeta Kumar', 'admin'),
      p('Lakshmikanth M', 'admin'),
      p('Ravi Pal', 'admin'),
      p('reena', 'member'),
    ];
    expect(order(roster)).toEqual([
      'Rohan Rahman',
      'Lakshmikanth M', 'Mohan Kumar K', 'Neeta Kumar', 'Ravi Pal',
      'Kanagala Lokesh Kumar', 'Kevin Philip', 'reena',
    ]);
  });
});
