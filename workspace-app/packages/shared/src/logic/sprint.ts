import type { JiraItem } from '../domain';
import { pd, startOfDay } from './time';

export const JIRA_GROUPS = [
  ['mine', 'Voor jou om te testen'],
  ['accept', 'Ready to Accept'],
  ['review', 'In review'],
  ['progress', 'In progress'],
  ['todo', 'To do'],
  ['done', 'Klaar'],
] as const;
export type JiraGroup = (typeof JIRA_GROUPS)[number][0];

export function jiraGroup(i: JiraItem): JiraGroup {
  const st = (i.status || '').toLowerCase();
  if (i.mine && /ready to accept/.test(st)) return 'mine';
  if (i.cat === 'done') return 'done';
  if (/ready to accept/.test(st)) return 'accept';
  if (/review/.test(st)) return 'review';
  if (i.cat === 'indeterminate') return 'progress';
  return 'todo';
}

export interface SprintSummary {
  name: string;
  goal?: string;
  start: Date;
  end: Date;
  daysLeft: number;
  totalPts: number;
  donePts: number;
  acceptPts: number;
  progPts: number;
  mine: number;
  count: number;
}

export function sprintInfo(issues: JiraItem[], now: Date): SprintSummary | null {
  if (!issues.length) return null;
  const sp = issues.map((i) => i.sprint).find(Boolean);
  if (!sp) return null;
  const end = pd(sp.endDate);
  const start = pd(sp.startDate);
  const pts = (g: (i: JiraItem) => boolean) => issues.filter(g).reduce((s, i) => s + (i.sp || 0), 0);
  return {
    name: sp.name,
    goal: sp.goal,
    start,
    end,
    daysLeft: Math.max(0, Math.ceil((+startOfDay(end) - +startOfDay(now)) / 864e5)),
    totalPts: pts(() => true),
    donePts: pts((i) => i.cat === 'done'),
    acceptPts: pts((i) => /ready to accept/i.test(i.status)),
    progPts: pts((i) => i.cat === 'indeterminate' && !/ready to accept/i.test(i.status)),
    mine: issues.filter((i) => jiraGroup(i) === 'mine').length,
    count: issues.length,
  };
}
