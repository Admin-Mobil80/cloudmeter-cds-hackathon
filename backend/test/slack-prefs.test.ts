/**
 * One person, many workspaces, one Slack connection each.
 *
 * Notification preferences are stored once per CloudMeter user. That is right
 * for email and WhatsApp — an address and a phone number are the same person
 * wherever they are — and wrong for Slack, where an account exists only inside
 * one Slack workspace and a DM channel id means nothing outside it.
 *
 * neeta@mobil80.com is an Admin in twelve prod workspaces under one user id.
 * With a single connection per person, the second workspace to install Slack
 * would be handed a channel belonging to the first: its token cannot reach
 * that channel, Slack refuses, the error lands in a log, and she silently
 * stops receiving one workspace's digest while the page still says
 * "Connected".
 *
 * It fails safely — a token only reaches its own workspace, so no spend can
 * land in the wrong Slack — but invisibly, which is the worse way to fail.
 */

import {
  slackConnection, slackDmChannel, withSlackConnection, withSlackBroken,
} from '../functions/shared/slack-prefs';

const MOBIL80 = '4ddba02e-c1db-40d3-8057-842a5f546009';
const GLOBEX = 'b6b48289-f40a-4507-900a-9e4eef536c58';

const prefsWith = (workspaces: Record<string, unknown>) => ({
  channels: { whatsapp: { connected: true, phone: '+91…' }, slack: { workspaces } },
});

describe('reading a connection', () => {
  it('finds the one for this workspace', () => {
    const prefs = prefsWith({ [MOBIL80]: { connected: true, dmChannelId: 'D-mobil80' } });
    expect(slackDmChannel(prefs, MOBIL80)).toBe('D-mobil80');
  });

  it('does not hand one workspace another\'s channel', () => {
    // The whole point. Connected in Mobil80, nothing in Globex.
    const prefs = prefsWith({ [MOBIL80]: { connected: true, dmChannelId: 'D-mobil80' } });
    expect(slackDmChannel(prefs, GLOBEX)).toBeNull();
  });

  it('keeps the two apart when both are connected', () => {
    const prefs = prefsWith({
      [MOBIL80]: { connected: true, dmChannelId: 'D-mobil80' },
      [GLOBEX]: { connected: true, dmChannelId: 'D-globex' },
    });
    expect(slackDmChannel(prefs, MOBIL80)).toBe('D-mobil80');
    expect(slackDmChannel(prefs, GLOBEX)).toBe('D-globex');
  });

  it('treats a disconnected workspace as having nothing', () => {
    const prefs = prefsWith({ [MOBIL80]: { connected: false, dmChannelId: 'D-old' } });
    expect(slackDmChannel(prefs, MOBIL80)).toBeNull();
  });

  it('treats a connection with no channel as unusable', () => {
    // Connected but nowhere to post is not a connection.
    expect(slackDmChannel(prefsWith({ [MOBIL80]: { connected: true } }), MOBIL80)).toBeNull();
  });

  it('ignores a legacy flat connection rather than guessing its workspace', () => {
    /*
     * An old record carries no record of which workspace it belonged to.
     * Falling back to it would be the original bug in disguise: a channel from
     * one workspace handed to another workspace's token. Stored connections
     * were migrated into the map instead.
     */
    const legacy = { channels: { slack: { connected: true, dmChannelId: 'D-unknown' } } };
    expect(slackDmChannel(legacy, MOBIL80)).toBeNull();
  });

  it('survives a user with no preferences at all', () => {
    expect(slackDmChannel(undefined, MOBIL80)).toBeNull();
    expect(slackDmChannel({}, MOBIL80)).toBeNull();
    expect(slackConnection({ channels: {} }, MOBIL80)).toBeNull();
  });
});

describe('writing a connection', () => {
  it('leaves the other workspaces alone', () => {
    // Someone connected in three workspaces keeps the other two when they
    // change one.
    const before = { slack: { workspaces: {
      [MOBIL80]: { connected: true, dmChannelId: 'D-mobil80' },
    } } };
    const after = withSlackConnection(before, GLOBEX, { connected: true, dmChannelId: 'D-globex' });

    expect(slackDmChannel({ channels: after }, MOBIL80)).toBe('D-mobil80');
    expect(slackDmChannel({ channels: after }, GLOBEX)).toBe('D-globex');
  });

  it('removes only the workspace being disconnected', () => {
    const before = { slack: { workspaces: {
      [MOBIL80]: { connected: true, dmChannelId: 'D-mobil80' },
      [GLOBEX]: { connected: true, dmChannelId: 'D-globex' },
    } } };
    const after = withSlackConnection(before, GLOBEX, null);

    expect(slackDmChannel({ channels: after }, MOBIL80)).toBe('D-mobil80');
    expect(slackDmChannel({ channels: after }, GLOBEX)).toBeNull();
  });

  it('does not disturb the other channels', () => {
    // This writer knows about Slack and nothing else; WhatsApp and any future
    // channel must come through untouched.
    const before = { whatsapp: { connected: true, phone: '+919876543210' } };
    const after = withSlackConnection(before, MOBIL80, { connected: true, dmChannelId: 'D1' });
    expect(after.whatsapp).toEqual({ connected: true, phone: '+919876543210' });
  });

  it('does not mutate what it was given', () => {
    // The caller holds the stored record; writing through it would change
    // history under a later read in the same request.
    const before = { slack: { workspaces: { [MOBIL80]: { connected: true, dmChannelId: 'D1' } } } };
    const snapshot = JSON.stringify(before);
    withSlackConnection(before, GLOBEX, { connected: true, dmChannelId: 'D2' });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('starts a map for someone who has never connected', () => {
    const after = withSlackConnection(undefined, MOBIL80, { connected: true, dmChannelId: 'D1' });
    expect(slackDmChannel({ channels: after }, MOBIL80)).toBe('D1');
  });

  it('replaces a legacy flat shape rather than keeping it beside the map', () => {
    // Two shapes for one thing is how a reader ends up consulting the wrong
    // one. The flat value goes when the map is written.
    const before = { slack: { connected: true, dmChannelId: 'D-old' } };
    const after = withSlackConnection(before, MOBIL80, { connected: true, dmChannelId: 'D-new' });
    expect(after.slack).toEqual({ workspaces: { [MOBIL80]: { connected: true, dmChannelId: 'D-new' } } });
  });
});

describe('marking a dead Slack install', () => {
  /*
   * A revoked install used to fail into a CloudWatch log and nowhere else:
   * every digest to that person silently failed, their page went on saying
   * "Connected", and nobody found out. The same shape as the WhatsApp channel
   * that looked connected for eleven people and delivered nothing for weeks.
   *
   * Telling them in Slack is impossible — Slack is what is broken — so the
   * connection is marked not-connected, which is what the page reads.
   */
  const connected = {
    slack: { workspaces: { [MOBIL80]: {
      connected: true, slackUserId: 'U1', dmChannelId: 'D1', connectedAt: '2026-10-07T09:34:54.000Z',
    } } },
  };

  it('turns the connection off, so the page stops claiming it works', () => {
    const after = withSlackBroken(connected, MOBIL80, 'token_revoked');
    expect(slackDmChannel({ channels: after }, MOBIL80)).toBeNull();
  });

  it('keeps what it was, so the failure can be explained afterwards', () => {
    const after = withSlackBroken(connected, MOBIL80, 'token_revoked');
    const entry = (after.slack as { workspaces: Record<string, Record<string, unknown>> })
      .workspaces[MOBIL80];
    expect(entry.slackUserId).toBe('U1');
    expect(entry.dmChannelId).toBe('D1');
    expect(entry.connectedAt).toBe('2026-10-07T09:34:54.000Z');
  });

  it('records why and when', () => {
    const after = withSlackBroken(connected, MOBIL80, 'not_in_channel');
    const entry = (after.slack as { workspaces: Record<string, Record<string, unknown>> })
      .workspaces[MOBIL80];
    expect(entry.disconnectedReason).toBe('not_in_channel');
    expect(typeof entry.disconnectedAt).toBe('string');
  });

  it('leaves the person\'s other workspaces connected', () => {
    /*
     * One workspace removing the app says nothing about another. Marking all
     * of them would take Slack away from workspaces that are working fine.
     */
    const two = { slack: { workspaces: {
      [MOBIL80]: { connected: true, dmChannelId: 'D-mobil80' },
      [GLOBEX]: { connected: true, dmChannelId: 'D-globex' },
    } } };
    const after = withSlackBroken(two, MOBIL80, 'token_revoked');
    expect(slackDmChannel({ channels: after }, MOBIL80)).toBeNull();
    expect(slackDmChannel({ channels: after }, GLOBEX)).toBe('D-globex');
  });

  it('does not disturb the other channels', () => {
    const withWa = { ...connected, whatsapp: { connected: true, phone: '+919876543210' } };
    const after = withSlackBroken(withWa, MOBIL80, 'invalid_auth');
    expect(after.whatsapp).toEqual({ connected: true, phone: '+919876543210' });
  });

  it('does not mutate what it was given', () => {
    const snapshot = JSON.stringify(connected);
    withSlackBroken(connected, MOBIL80, 'token_revoked');
    expect(JSON.stringify(connected)).toBe(snapshot);
  });

  it('is safe on a workspace that was never connected', () => {
    // A failure for someone with no stored connection should not invent one
    // that looks like it used to work.
    const after = withSlackBroken(undefined, MOBIL80, 'channel_not_found');
    expect(slackDmChannel({ channels: after }, MOBIL80)).toBeNull();
  });
});
