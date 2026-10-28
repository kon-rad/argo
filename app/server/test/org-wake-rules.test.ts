import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { getAgent, importOrg, openWakeups, OrgError, post } from '../src/org.js';
import { truncateAll } from './helpers.js';

const ORG = {
  version: 'wake-1',
  company: 'Acme',
  ceo: 'owner',
  agents: {
    owner: { runtime: 'human', role: 'CEO', channels: ['*'] },
    atlas: { role: 'Head of Platform', team: 'platform', reports_to: 'owner' },
    rune: { role: 'Platform engineer', team: 'platform', reports_to: 'atlas' },
    juno: { role: 'Head of Media', team: 'media', reports_to: 'owner' },
  },
  teams: {
    platform: { name: 'Platform', lead: 'atlas' },
    media: { name: 'Media', lead: 'juno' },
  },
  channels: {
    'all-hands': { members: '*', purpose: 'company-wide' },
    'build-room': { members: ['platform'], purpose: 'builds' },
  },
};

async function woken(agent: string): Promise<string[]> {
  return (await openWakeups(agent)).map((w) => w.reason);
}

describe('wake rules', () => {
  beforeEach(truncateAll);

  it('defaults keep the old behaviour: an untagged owner post wakes nobody', async () => {
    await importOrg(ORG);
    await post(await getAgent('owner'), 'media', 'please write something');
    expect(await woken('juno')).toEqual([]);
  });

  it('owner_channel_post: wake_lead wakes the team lead once, with reason owner', async () => {
    await importOrg({ ...ORG, wake_rules: { owner_channel_post: 'wake_lead' } });
    await post(await getAgent('owner'), 'media', 'please write something');
    expect(await woken('juno')).toEqual(['owner']);
    expect(await woken('atlas')).toEqual([]);
  });

  it('a tagged owner post wakes only the tagged bot, not the lead as well', async () => {
    await importOrg({ ...ORG, wake_rules: { owner_channel_post: 'wake_lead' } });
    await post(await getAgent('owner'), 'platform', '@rune look at this', { mentions: ['rune'] });
    expect(await woken('rune')).toEqual(['owner']);
    expect(await woken('atlas')).toEqual([]);
  });

  it('a bot post and an owner status never wake the lead', async () => {
    await importOrg({ ...ORG, wake_rules: { owner_channel_post: 'wake_lead' } });
    await post(await getAgent('rune'), 'platform', 'fyi');
    await post(await getAgent('owner'), 'platform', 'done?', { kind: 'status' });
    expect(await woken('atlas')).toEqual([]);
  });

  it('a shared channel has no lead unless channel_leads names one', async () => {
    await importOrg({ ...ORG, wake_rules: { owner_channel_post: 'wake_lead' } });
    await post(await getAgent('owner'), 'build-room', 'status of the build?');
    expect(await woken('atlas')).toEqual([]);
    await importOrg({ ...ORG, wake_rules: { owner_channel_post: 'wake_lead', channel_leads: { 'build-room': 'atlas' } } });
    await post(await getAgent('owner'), 'build-room', 'status of the build, again?');
    expect(await woken('atlas')).toEqual(['owner']);
  });

  it('mention: false turns off tag wakes; the import replaces the rules whole', async () => {
    await importOrg({ ...ORG, wake_rules: { mention: false } });
    await post(await getAgent('owner'), 'platform', '@rune hi', { mentions: ['rune'] });
    expect(await woken('rune')).toEqual([]);
    await importOrg(ORG);
    const { rows } = await query<{ rules: object }>(`SELECT rules FROM org_wake_rules`);
    expect(rows[0]!.rules).toEqual({});
  });

  it('rejects unknown keys, a bad value, an unknown channel and a human as a channel lead', async () => {
    await expect(importOrg({ ...ORG, wake_rules: { owner_channel_post: 'everyone' } })).rejects.toThrow();
    await expect(importOrg({ ...ORG, wake_rules: { wake_everybody: true } })).rejects.toThrow();
    await expect(importOrg({ ...ORG, wake_rules: { channel_leads: { nowhere: 'atlas' } } })).rejects.toThrow(OrgError);
    await expect(importOrg({ ...ORG, wake_rules: { channel_leads: { 'build-room': 'owner' } } })).rejects.toThrow(OrgError);
  });
});
