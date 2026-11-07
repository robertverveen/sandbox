/**
 * Harness-dataset: dezelfde nep-bronnen als het voorbeeldharnas waarmee de lat (het prototype)
 * met echte contextdata wordt geladen (tools/bar). Datums zijn relatief aan "nu", zodat
 * tools/bar en tools/shot dezelfde data laten zien. Synthetisch; de echte context komt uit
 * HZ_CONTEXT_EXPORT (alleen runtime).
 */
import type { CommitItem, MailItem, MeetingItem, SlackItem, TaskItem, Weekdoel } from '@hz/shared';
import { addDays, hm, isoWeek, ymd } from '@hz/shared/logic';
import { SELF_EMAIL, SLACK_ME } from './demo';

export function harnessData(now: Date) {
  const day = (k: number) => ymd(addDays(now, k));
  const ev = (id: string, k: number, s: string, e: string, title: string, att: string[]): MeetingItem => ({
    id,
    type: 'meeting',
    title,
    start: `${day(k)}T${s}`,
    end: `${day(k)}T${e}`,
    calId: SELF_EMAIL,
    entities: [],
    attendeeNames: att.map((a) => a.split('@')[0]!).map((n) => n.charAt(0).toUpperCase() + n.slice(1)),
    attendees: att.map((a) => ({ email: a, responseStatus: 'accepted' as const, self: a === SELF_EMAIL })),
    external: att.some((a) => !a.endsWith('@homezero.nl')),
    url: 'https://calendar.google.com/x',
  });
  const ago = new Date(+now - 3600_000);
  const hourAgo = `${ymd(ago)}T${hm(ago)}`;
  const meetings: MeetingItem[] = [
    ev('fe1', 0, '13:00', '14:00', 'Feenstra · opleversessie', [SELF_EMAIL, 'sanne@voorbeeldpartner.nl']),
    ev('ww1', 1, '11:00', '12:00', 'Voorbeeldinstallateur - HomeZero', [SELF_EMAIL, 'info@voorbeeldinstallateur.nl']),
  ];
  const mails: MailItem[] = [
    {
      id: 'gm:t1',
      type: 'mail',
      threadId: 't1',
      title: 'Meterkastcheck',
      fromName: 'Sanne de Wit',
      from: 'sanne@voorbeeldpartner.nl',
      time: hourAgo,
      unread: true,
      direct: true,
      entities: [],
      count: 2,
    },
  ];
  const slack: SlackItem[] = [
    {
      id: 'sl:CFE:1',
      type: 'slack',
      channel: '#feenstra-hz',
      channelId: 'CFE',
      ts: `${Math.floor(Date.now() / 1000) - 3600}.000100`,
      fromName: 'Sanne de Wit',
      fromId: 'UMB',
      time: hourAgo,
      title: '@Robert kun je even kijken naar de opleverlijst?',
      mention: true,
      entities: [],
      url: 'https://homezero-workspace.slack.com/archives/CFE/p1',
    },
  ];
  const tasks: TaskItem[] = [
    {
      id: 'g1',
      type: 'task',
      rawId: 'g1',
      tasklist: 'L',
      tasklistTitle: 'My Tasks',
      title: 'Recap met prioriteitenlijst op Slack delen',
      due: day(1),
      status: 'needsAction',
      entities: [],
    },
    {
      id: 'g2',
      type: 'task',
      rawId: 'g2',
      tasklist: 'L',
      tasklistTitle: 'My Tasks',
      title: 'Offerte Feenstra nalopen',
      due: day(0),
      status: 'needsAction',
      entities: [],
    },
  ];
  const commits: CommitItem[] = [
    {
      id: 'cm:old-mijn',
      docId: 'old-mijn',
      type: 'commit',
      title: 'Oude belofte zonder taak',
      stroom: 'mijn',
      status: 'open',
      entities: [],
      body: 'Eigen invoer',
    },
    {
      id: 'cm:q1',
      docId: 'q1',
      type: 'commit',
      title: 'Lisanne: oppikken morgen',
      stroom: 'aan_mij',
      status: 'open',
      aan: 'Lisanne',
      reminder: day(2),
      time: `${day(-1)}T09:00`,
      entities: [],
      body: 'Lisanne · Slack · DM',
    },
  ];
  const weekdoelen: Weekdoel[] = [
    { id: 'wd', wat: 'Weekdoel A', soort: 'weekdoel', week: '2026-W45', status: 'open', checks: [] },
  ];
  return {
    now,
    calendars: [{ id: SELF_EMAIL, summary: SELF_EMAIL, primary: true }],
    meetings,
    mails,
    slack,
    tasks,
    tasklists: [{ id: 'L', title: 'My Tasks' }],
    commits,
    weekdoelen,
    week: isoWeek(now),
    slackMe: SLACK_ME,
  };
}
