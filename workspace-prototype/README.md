# Home Zero Workspace: prototype

A clickable first prototype of a single workspace where Slack, mail, tasks, Google Calendar, Google Drive and the **contextlaag** (Home Zero's context layer: a GitHub repo holding all company context) come together.

Open `index.html` in a browser. It's one self-contained file with no build step. All data in it is **demo data**.

## What you can try

| Part | What it shows |
|---|---|
| **⌘K / Ctrl+K** (or `/`) | Master search bar. `veenstra` gives a context card for the partner first, then results grouped by source (context layer, meetings, mail, Slack, tasks, Drive). |
| **Keywords** | Build views with `@veenstra`, `type:mail`, `from:sanne`, `in:#dev`, `when:week`, `is:open`, `is:unread`, `is:pending`. Save any search as a view in the sidebar with **⌘↵** (or "Bewaar als view"). Tab on a partner adds `@partner` to the query. |
| **Commands** | Start with `>`: write back the latest meeting, ask the context layer, add a task, toggle theme. |
| **Vandaag** | Day timeline with the context status of each meeting, a briefing for the next meeting, tasks and new activity. |
| **Agenda** | Week view. Colour shows whether a meeting has been written back (green), is waiting for write-back (orange) or has a briefing ready (blue). |
| **Meeting** | *Before:* a briefing from the context layer (agreements, open questions, previous meeting). *After:* a proposal from the transcript (summary, decisions, action items → Google Tasks, Slack questions that got answered) plus a diff of the context-layer files. "Wegschrijven" (write back) commits it and updates the partner context everywhere. |
| **Partnerpagina** (partner page) | Everything about one partner: context-layer facts, a timeline across all sources, upcoming meetings, open tasks. |
| **Chat** | A layer over Slack: all channels and DMs in one stream, plus "Vraag Home Zero" for questions answered by the context layer with sources. |
| **Activiteit** | A stream of everything, plus a quick-add box for tasks (`@veenstra Jeroen bellen morgen`). |

## Data model (basis for the real app)

Every item (mail, Slack message, meeting, context file, task, Drive file) has a type, a time and a list of **entities** (partner, product, person). Search, views, briefings and the "related" panel all work through those entity links. The context layer is the source of truth for each entity:

```
homezero/context/
  partners/<partner>/README.md        # profile, status, contacts
  partners/<partner>/afspraken.md     # running agreements (checklists)
  partners/<partner>/meetings/<date>-<type>.md   # written-back meetings, with frontmatter
  product/pico/...
```

A written-back meeting gets frontmatter that links it to the calendar event and the transcript (`agenda:` and `bron:`). That's how the calendar invite can show its context right away.

## Next steps

1. **Connectors**: Gmail, Slack, Google Calendar/Tasks/Drive and GitHub through their APIs (or the MCP connectors we already use), with an indexer that recognises entities per item.
2. **Write-back pipeline**: transcript (Wispr Flow / tl;dv / Fireflies) → Claude proposes the summary, decisions, tasks and diff → review → commit + Google Tasks + Slack reply.
3. **App shell**: build it as a web app first (e.g. Next.js), then wrap it as a Mac app (Tauri or Electron) for a global ⌘K hotkey and notifications.
4. **Search**: a local index (SQLite FTS / embeddings) over all sources, with the keyword syntax from this prototype as the query language.
