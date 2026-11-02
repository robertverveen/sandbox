# Home Zero Workspace

Robert's visual layer and inbox on top of the Home Zero ecosystem: agenda, mail, Slack, Google Tasks, Wispr meetings and the commitment tracker in one place, keyboard-first, working together with Claude.

Live version (private): https://claude.ai/artifact/4CzejHBSKjJNrvBNESpYw4. Opened locally, `index.html` runs on example data.

## Screens

The main navigation has five items only: **Dagstart, Planning, Agenda, Tracker and Chat**. Everything else (saved views, partners, wegschrijven/write-back, settings) is reached through `⌘K`. Less is more: each screen shows one thing at a time and keeps the rest one key away.

| Screen | Keys | What it does |
|---|---|---|
| **Dagstart** (day start) | `g d` | A felt yellow header with the greeting and one line: how many items need a decision, today's load (x/10) and the next meeting, plus the **Start plansessie** button. Below it: the morning briefing as one collapsed line, **Vandaag** (today, max 10) next to **Agenda vandaag**, and "Om te beslissen" (to decide) folded away. Two chips at the bottom: the current sprint and the week goals. |
| **Planning** | `g p`, `v` | Tab **Mijn planning**: late · today · tomorrow · later this week · next week · no date · backlog (Google Tasks and the tracker together). Tab **Sprint** (`v`): the current Jira sprint of project HOM, with a progress bar by status, "Voor jou om te testen" (where you are the Tester) at the top, then the stories by status. |
| **Plan session** | `s` | Card by card on a felt blue plane: week goals and roadmap first (`g` on track, `o` at risk, `r` blocked, `x` done, `n` note), then everything that needs a decision (`1`–`5` plan, `e`, `w`, `b`, `x`). `s` skip, `u` back. |
| **Agenda** | `g a`, `[` `]`, `l`, `n` | All Google calendars in one week view, in Dutch time, with Google Tasks in the all-day row. `l` opens the layers (Werk, Privé, Lou, Collega's); `n` plans something with colleagues (free slots via `suggest_time`). |
| **Tracker** | `g t`, `⇧1–7` | Ik beloofde (I promised) · Wachten op (waiting for) · Bespreken (raise at next contact) · Voornemens (intentions) · Weekdoelen (week goals) · Roadmap · Afgerond (done). Replaces the Slack canvas "⏳ Wachten op". |
| **Chat (Gesprekken)** | `g c`, `s`, `i` | All mail threads, DMs, group DMs and channels you are in, readable in full: channel history with day separators, threads that unfold inline, and complete mail threads (older messages folded, quoted text hidden, attachment names). Reply directly from the app. **Inhalen** (`s`) works through everything unread, one conversation at a time. |
| **⌘K and Zoeken** | `⌘K`, `g 1–9` | Type an organisation and refine with commas: `Solarwatt, berekening, timeline`. See *Zoeken* below. |

## Gesprekken and Inhalen

- **Full context everywhere.** Selecting a Slack message, mail, task or tracker item opens the inspector with the complete thread or mail. Tasks and commitments created from Slack or mail keep the permalink, so their context comes back too.
- **Inhalen (catch up)** works like Catch up in Slack mobile: one card per unread conversation, with the unread messages highlighted. The keys are:
  - `→`/`e` read
  - `←`/`u` keep unread
  - `1`–`5` make a Google Task (today … backlog) and mark read
  - `r` type a reply; `↵` sends it and marks the conversation done
  - `⇧E` read plus ✅ in Slack
  - `z` undo
  - `Esc` stop
- **Reactions.** `↵` sends without closing the card: you see your reply in the conversation, then go on with `→`. Quick reactions (👍 ✅ 👀 🙏 🙌 ❤️) react and mark read in one go. Hovering a message in Gesprekken shows the same reaction bar.
- **Tags and emoji.** In the reply box, `@` suggests people. Suggestions come from conversations, DMs and `slack_search_users`, and a pick becomes a real `<@U…>` tag when sent. `:` suggests emoji: all ~1,960 standard Slack shortcodes are built in, plus workspace emoji via `slack_search_emojis`. Custom emoji show as a label, because the connector gives no image.
- **An emoji reaction counts as read.** Reacting from the app marks the item read. Every 3 minutes the app also checks open Slack items with `slack_get_reactions`, so a reaction you placed in Slack itself also marks the item read.
- **Replying.** Slack replies go to the conversation, or to the thread when the unread message was in a thread (`slack_send_message`). Mail replies use Gmail `reply`, with your signature and optional reply-all.
- **Read state.**
  - Mail is marked read in Gmail. Undo puts `UNREAD` back.
  - The Slack connector can neither read nor set Slack's own read marker. A message therefore counts as handled when you mark it here, reply to it here or in Slack, or post later in the same conversation or thread.
  - Real two-way read sync needs the Slack API (see below).
- **Token-efficient loading.** The lists come from cheap list calls, refreshed hourly for channels and every 5 minutes for mail. A conversation's history is fetched only when you open it and is cached for 2 minutes.

## Zoeken (search)

- **Organisations are recognised as you type.** They come from mail domains, `-hz` Slack channels and the context layer. `Tab` completes the name and adds a comma.
- **Comma-separated segments:**
  - an organisation
  - one or more topics: Dutch word forms are included, so "berekening" also finds berekenen and berekend
  - a source: `mail`, `slack`, `meetings`, `taken`
  - a period: `deze week`, `maand`, `30d`
  - `timeline`
- **Live search.** Gmail (by the organisation's domains, sender, recipient and cc, plus the name) and Slack (the organisation's `-hz` channel plus mentions elsewhere, with stem wildcards). It also covers local agenda, tasks, tracker and Wispr items. Every result opens with its full context in the inspector.
- **Timeline.** For up to 15 matching mail threads, every message shows who → to whom (cc), when, the subject and a snippet. Slack messages and meetings are merged in, with a summary of volume, period and who was most involved.
- **Breder zoeken (search wider).** On request only, Claude suggests related terms (for example rekenmodel or calculatie) and the search reruns with them.
- **Pinned views.** `Vastzetten` (or `⌘↵` in the palette) pins a search to the sidebar under the five main items. `g 1`–`g 9` opens a pin. Pins are stored in the workspace database.

## Week rhythm

Borrowed from Standupy, a friend's standup app:

- **Week review.** At the start of a new week, last week's open goals come first in the plan session. Each gets one of four outcomes:
  - `x` gehaald (achieved)
  - `m` meenemen (carry over): a copy becomes this week's goal
  - `d` doorgeschoven (slipped): it stays open as a commitment, so it is still owed
  - `l` losgelaten (dropped): consciously let go

  The difference between slipped and dropped is the point: slipped work is debt, dropped work is not.
- **Week score.** The Weekdoelen tab shows, for the last four weeks, how many goals were achieved, dropped or still open.
- **Plan je week met Claude.** This opens claude.ai with a prefilled prompt. The prompt holds last week's outcomes, this week's goals, open commitments, waiting-for items and meetings per day. It coaches you through review → 2–3 outcomes → timebox → record, using `zondag-weekprep` when available. The recap flow uses the same link when starting a Claude session fails.

## Team web app: one-time login instead of MCP

The artifact talks to Slack and Gmail through the claude.ai connectors (MCP). For a web app that every colleague can use, each person logs in once with OAuth, the same way you add an account to Apple Mail or Spark.

| | How | Effort |
|---|---|---|
| **Google (Gmail, Agenda, Taken)** | One "Log in met Google" screen requesting `gmail.modify`, `calendar.events` (+ `calendar.readonly`) and `tasks`, with `access_type=offline` for a refresh token. Set the consent screen to **Internal** in Google Cloud. Then only @homezero.nl accounts can log in, and Google requires no verification or yearly security assessment, which is otherwise mandatory for Gmail scopes. | ~1 week incl. token storage, refresh and API routes |
| **Slack** | A HomeZero-internal Slack app with OAuth v2 user scopes. "Koppel Slack" is one click; you get a user token (`xoxp-`, optionally with token rotation). The user scopes are: `channels/groups/im/mpim:history`, `…:read`, `…:write` (for `conversations.mark`, real mark as read), `chat:write`, `reactions:write`, `search:read`, `users:read`. Keep it internal: Slack's 2025 rate-limit cuts on `conversations.history` apply to commercially distributed non-Marketplace apps, not to an app built for your own workspace. | 3–5 days; live updates (Events API or Socket Mode) +2–3 days |
| **Live updates** | Gmail `users.watch` → Pub/Sub (renew within 7 days), Calendar `events.watch` channels. Tasks has no push, so poll it. | 2–3 days |

Suggested stack (as in Standupy): React + Vite, Supabase (Postgres with RLS, Auth with the Google provider, Edge Functions) and Vercel.

- Supabase returns the Google `provider_refresh_token` at login but does not refresh it. Store it encrypted and refresh it in an edge function.
- A `team_members` table is the allowlist.
- Like Standupy, the app can expose its own **MCP server with OAuth 2.1**. Each colleague's Claude (routines and skills) can then read and write their own workspace directly, which replaces the ArtifactData dual landing.

Not recommended: Google domain-wide delegation via a service account. It needs no user login, but it can read everyone's mail.

In the code, all source calls sit in a few functions: `loadConv`, `loadThread`, `sendReply`, `convMarkRead`, `markRead` and the watches. The web app swaps only those for `/api/slack/*` and `/api/gmail/*` routes.

## Agenda colours and layers

The colours follow Robert's Google Calendar:

| Colour | Calendar |
|---|---|
| Yellow | HomeZero (robert@homezero.nl) |
| Blue | robertverveen@gmail.com |
| Green | Vakanties & Vrij |
| Purple | everything from Lou |

Lou's items (sport, dinner, appointments) and colleagues' calendars show **only in the Agenda**. They never appear in Dagstart, Planning or the tracker. The connector does not expose calendar colours, so these are defaults per calendar and can be changed in the layers panel.

## Jira

Sprint data comes live from Atlassian (`searchJiraIssuesUsingJql`, project HOM, `sprint in openSprints()`), refreshed every 10 minutes. Story points are `customfield_10016` and sprint dates come from `customfield_10020`. A second query (`Tester = currentUser()`) marks the stories you have to test. `o` on a story opens it in Jira.

## Brand

The app uses the HomeZero website identity. The same rules are published as the design system "HomeZero Website" (https://claude.ai/artifact/J9pm73jfwMAzDwGtgsHSxD), next to Pico and Configurator.

- **Type:** Inter Variable, embedded.
- **Colours:** the page is `#fbfbf8`, ink `#292f38`, blue-500 `#0022c4` for actions and focus, yellow-500 `#f9b20b` for accents. Dark mode is navy (grey-900).
- **Felt planes:** brand blocks get a flat colour, the 256px grain tile on top (overlay, 0.8; 0.55 on blue) and the brand shapes behind the content. Examples are the Dagstart header (yellow-200, with a quarter disc and a ring) and the plan session (blue-500, with a ring, a disc and a dot).
- **No drop shadows;** radii are 8/12/24.
- **Agenda colours** are the one exception: they follow Google.

## Routines: landing in two places

The routines **Ochtendbriefing** (morning briefing, Tue–Fri 07:14) and **Zondag weekprep** (Sunday 19:45) still send to Telegram as before. They now also write to the workspace: the briefing goes into `briefings/<date>` (shown at the top of Dagstart), and the week goals go into the tracker as `weekdoel` items with a daily health check in the plan session. Once that has proven itself for a few weeks, a morning app notification can replace Telegram.

Personal context layer: see `../personal-context/README.md` (Obsidian vault + index + MCP server).

## Keyboard

`j`/`k` move · `↵` details · `o` open in the source app · `?` overview.
**Planning:** `1` today · `2` tomorrow · `3` later this week (least busy day) · `4` next week · `5` backlog · `x` done.
**Processing:** `e` read (mail is also marked read in Gmail) · `⇧E` read + ✅ reaction in Slack · `w` waiting for · `b` raise at next contact · `c` make a commitment · `r` recap with Claude · `t` pull commitments out (Claude) · `y`/`m`/`n` answer an invite.

## What planning does in the ecosystem

- **Google Tasks** stays the task list. `1–4` writes the date into Google Tasks. `5` moves the task to a "Backlog" list. Slack, mail and tracker items get a Google Task when you plan them, marked `[workspace]`. Prep tasks are titled `🛠 Prep: <meeting> (30 min)` with `[briefing]`, so `/morning-briefing` recognises them.
- **The tracker tracks everything.** A planned Slack message or mail becomes a commitment linked to its Google Task. Ticking either one off closes both. Wachten op and Bespreken are never Google Tasks (same rule as the briefing skill).
- **`/klant-recap`:** `r` on a meeting or Wispr recording starts a Claude session with `/klant-recap`, the partner, the date, the Wispr link and the attendees. Claude prepares the Slack drafts and updates the partner portal. The workspace then shows "recap ✓" once the internal update appears in #04-klanten.
- **Max 10 per day:** the counter turns red above 10, and `3`/`4` pick the least busy day.

## Slack: how it comes in, and marking as read

Currently: through the Slack connector of claude.ai (search API, read-only, as Robert). It fetches DMs and mentions addressed to you, your own messages (to detect what's already answered), 📣-marked messages and your recaps in #04-klanten. It refreshes every 5–15 minutes. The connector has **no mark-as-read**. So `e` marks something read in the workspace (stored privately), and `⇧E` also adds a visible ✅ in Slack. Gmail does mark as read for real (`unlabel_thread UNREAD`).

In a Mac app or web app: your own Slack app with a user token (OAuth, scopes `channels:history`, `groups:history`, `im:history`, `mpim:history` plus `channels:write`, `groups:write`, `im:write`, `mpim:write`). With that, `conversations.mark` sets the read marker for real. Socket Mode / Events API make it real-time instead of polling. Same for Gmail (`users.threads.modify`) and Google Tasks via the Google APIs.

## Personal vs shared (Mac app / web app)

| What | Where | Why |
|---|---|---|
| Read status, planning, commitments, Wachten op | Locally in the app (SQLite, encrypted) or a private store per user | Personal; nobody else needs it |
| Partner context, meeting notes, agreements | Context layer (GitHub, Home Zero) | Shared and lasting |
| Check-ins, partner to-dos | Partner portal | Shared view per partner |
| Tokens (Slack, Google) | macOS Keychain | Never in the app or in Claude |

**Token-efficient with Claude:** the app exposes its own state to Claude as a small MCP server (`get_inbox_delta`, `list_commitments`, `plan_item`, `mark_read`). Skills like `/morning-briefing` and `/dag-afsluiting` then read pre-sorted JSON with ids and deltas since the last run, instead of searching Slack, the canvas and threads all over again. In this prototype the tracker already lives in the artifact database (`commitments`, `itemstate`), readable by Claude in a chat with `read_db`.
