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
| **Chat** | `g c`, `i` | Slack addressed to you, plus Vraag Claude (ask Claude) about all sources. |
| **⌘K** | `⌘K` `/` | Search and commands. Keywords: `@feenstra type:mail when:week is:reageren`. |

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
