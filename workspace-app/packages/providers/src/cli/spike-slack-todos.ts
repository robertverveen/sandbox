/**
 * Proefscript spike HZW-037: wat kan met een Slack user token aan to-do's? Draait een mens, tegen de echte
 * HomeZero-workspace, met een eigen user token (nooit in Git):
 *
 *   SLACK_USER_TOKEN=xoxp-… SLACK_TEST_LIST_ID=F0… pnpm --filter @hz/providers spike:slack-todos [--write]
 *
 * Zonder --write alleen lezen. Met --write maakt het één testherinnering aan en verwijdert die meteen.
 * Uitkomst: per soort wel/niet, plus de scopes van het token (x-oauth-scopes). Niets wordt bewaard.
 */
import { LiveSlack } from '../live/slack';
import { probeSlackTodos } from '../live/slack-todos';
import { MemorySyncStore } from '../live/store';

const token = process.env.SLACK_USER_TOKEN;
if (!token || !token.startsWith('xoxp-')) {
  console.error('Zet SLACK_USER_TOKEN (user token, xoxp-…) in de omgeving. Nooit committen.');
  process.exit(2);
}
let scopes = '';
const fetchWithScopes: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  scopes ||= res.headers.get('x-oauth-scopes') ?? '';
  return res;
};
const slack = new LiveSlack(
  { accessToken: async () => token },
  { store: new MemorySyncStore(), fetchImpl: fetchWithScopes },
);
const results = await probeSlackTodos(slack, {
  listId: process.env.SLACK_TEST_LIST_ID,
  write: process.argv.includes('--write'),
});
console.log('Spike HZW-037: Slack-to-do’s met de user token\n');
for (const r of results) console.log(`${r.kan ? 'WEL ' : 'NIET'}  ${r.soort.padEnd(14)} ${r.detail}`);
console.log(`\nScopes van dit token: ${scopes || '(onbekend)'}`);
console.log('Zet de uitkomst in docs/spike-slack-todos.md (sectie Proefscript-uitkomst).');
