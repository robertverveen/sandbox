# Home Zero Workspace

One workspace where your agenda, mail, Slack, tasks, meetings and commitments come together, with a ⌘K search bar on top. It answers one question when you get to the office: **where should my attention go right now?**

Live version: https://claude.ai/artifact/4CzejHBSKjJNrvBNESpYw4 (private). Open it in claude.ai and it loads your own data through your connectors. Opened locally, `index.html` runs on example data.

## What's in it

| Screen | What it does |
|---|---|
| **Dagstart** (day start) | Welcome-back screen showing a top 5 of "here's where your attention goes", ranked by urgency: late commitments, external meetings with open commitments (the catcher), invites without a response, Slack messages and mail waiting on you, overdue tasks. Below that, three columns: **Reageren** (respond: Slack DMs and mentions you haven't answered, mail sent to you), **Verwerken** (process: Wispr meetings to pull commitments from, cc mail, notifications) and **Agenda** (the next working day, plus invites you can accept or decline right away). "Vat samen" (summarise) lets Claude brief you in five sentences. |
| **Agenda** | Week view from Google Calendar. External meetings, invites not yet accepted and the number of open commitments per organisation are all visible. Click a meeting to see attendees with their responses, open commitments and related items. |
| **Toezeggingen** (commitments) | The commitment tracker from the design of 7 October: three streams (what I promised, what was promised to me, my own intentions), statuses, evidence rules. **Haal op** (pull in): Claude extracts commitments from Slack, mail or a Wispr meeting, and you review them before they're added. **Zoek bewijs** (find evidence): searches your sent mail, your Slack messages and your agenda, and sets items to "waarschijnlijk klaar" (probably done). You confirm or object. Nothing closes automatically. |
| **Chat** | Slack messages addressed to you, mentioning you, and your own, in one stream, marked "wacht op jou" (waiting on you) or "beantwoord" (answered). "Vraag Claude" (ask Claude) answers questions about all your sources. |
| **⌘K** | Searches everything at once. Keywords build views: `@tonzon`, `type:mail`, `from:mike`, `in:-hz`, `when:week`, `is:reageren`, `is:invite`, `is:extern`, `type:commit is:te_laat`. Save any view with ⌘↵. |
| **Organisaties** | Built automatically from the email domains in your agenda and mail, and from `-hz` Slack channels. One page per organisation: timeline, open commitments, upcoming meetings. |
| **Meeting wegschrijven** (write back a meeting) | Concept with example data: how a meeting gets committed to the context layer (GitHub) once that repo is connected. |

## Connectors and storage

- Google Calendar (`list_events`, `respond_to_event`), Gmail (`search_threads`, `get_thread`), Slack (`slack_search_public_and_private`), Google Tasks (`today`, `overdue`, `complete`), Wispr Flow (`search_meetings`, `get_meeting`).
- Commitments live in the page's database (`commitments`, `processed`), readable and writable **only by the owner**.
- Claude (via `sample`) for extraction, the summary and chat.

## Next steps

1. Connect the context layer (GitHub repo): partner profiles on the organisation page, and meetings actually committed.
2. Schedule extraction and the evidence sweep (07:30 / 12:30 / 17:00) and fold them into the Telegram morning briefing.
3. Reply to Slack and mail directly from the workspace.
4. Mac shell (Tauri) for a global ⌘K hotkey and notifications.
