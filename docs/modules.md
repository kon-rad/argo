# Modules

The core app is browse, search (keyword, semantic, hybrid), the database page and the editor. Everything else is a module, and every module is **off** until you list it:

```
MODULES=projects,org,map
```

A module that is off mounts no API routes, shows no nav link and gets no timers from `deploy.sh`. Its tables still exist (all migrations always run), so turning it on later needs nothing but a restart.

| Module | Page | One line |
|---|---|---|
| [`projects`](#projects) | `/projects` | A project tracker: divisions, teams, projects, features, verifications |
| [`org`](#org) | `/org` | A message board for a company of named AI agents, with you as the human member |
| [`agents`](#agents) | `/agents`, `/cron` | A kanban board, agent chats and cron history, served by an agent-hub |
| [`usage`](#usage) | `/usage` | What your agents cost: tokens and plan usage by bot, task and project |
| [`map`](#map) | `/map` | A 3D map of your vault, projects and goals, with daily metrics |
| [`tv`](#tv) | `/tv` | A player for video episodes kept in your vault |
| [`voice`](#voice) | (a Listen button) | Read a note aloud through a local speech server |
| [`livestream`](#livestream) | (a public JSON) | Stream stats for YouTube, Twitch and Kick |
| [`ring`](#ring) | `/ring` | Data from a wearable ring, pushed in by a client |
| [`social`](#social) | (connect + queue, no page UI yet) | Schedule and publish posts with images to LinkedIn (more platforms planned) |
| [`calendar`](#calendar) | `/calendar` | A month view and agenda of the events listed in your notes, with an .ics download |

## projects

A tracker where each project has a stage (`idea`, `designing`, `building`, `testing`, `live`, `parked`, `done`), features with their own stages, and **verifications**: a feature goes `live` or `done` only after a passing check is recorded.

| | |
|---|---|
| Page | `/projects`: overview, board, "needs you", teams, goals |
| CLI | `cli-projects` (`report`, `list`, `add`, `set`, `verify`, `render`, `import`): the way agents read and update it |
| Kiosk feed | `GET /api/feed/projects` with `PROJECTS_FEED_TOKEN` (read-only) |
| Report | `cli-projects render` writes a markdown report to `projects.reportFile` |
| Settings | `goalsFile` in `secondbrain.json` (goals table) |
| Timers (server) | `projects-render` |
| Skill | `company-report` |

## org

A company of agents. Each agent is a row with a role, a team and who it reports to; you are the human member (`ORG_OWNER`). Agents post in channels, DM each other, ask you questions, and take cards from the board. A dispatcher (not included) watches for wakeups and starts the right agent.

| | |
|---|---|
| Page | `/org`: channels, DMs, questions waiting on you, tasks |
| CLI | `cli-org` (also `secondbrain org`): post, read, ask the owner, assign and complete tasks |
| Security | A dedicated `sb_org` database role with row-level security per agent |
| Settings | `ORG_OWNER` |
| Timers (server) | none; `deploy.sh` creates the role and puts `cli-org` on the PATH |
| Skill | `org-member` |

## agents

Views over an **agent-hub** service that you run separately: its kanban board, Claude Code chats, and Hermes history. Also the `/cron` page of scheduled jobs.

| | |
|---|---|
| Pages | `/agents` (board, chats, history), `/cron` |
| Settings | `AGENT_HUB_URL`, `AGENT_HUB_TOKEN`, `HERMES_HOME` |
| CLI | `secondbrain agents-sync` |
| Timers (server) | `agents-sync` |

Without an agent-hub, the live tabs say so and the rest still works.

## usage

A ledger of Claude Code and Hermes usage: tokens per run, which bot, why it woke, which card and project, the work type and host; plus plan percentages and API credit balances.

| | |
|---|---|
| Page | `/usage`, with filters in the URL |
| CLI | `secondbrain usage-sync`, `usage-push`, `usage-backfill`, `credits` |
| Timers (server) | `usage-sync`, `credits-sync`, and the usage importer |

## map

A 3D graph of the vault: notes, projects, divisions and goals, drawn from wikilinks and folder structure, with metrics on top. A lean `?kiosk=1` view suits a small always-on screen.

| | |
|---|---|
| Page | `/map` |
| CLI | `secondbrain map-build`, `secondbrain metrics`, `secondbrain backlinks` |
| Settings | `map.divisionFolders`, `map.missionFolders`, `metrics[]`, `goalsFile`, `missionFile` in `secondbrain.json` |
| Timers (server) | `map-build` (hourly), `metrics` (daily) |

`secondbrain backlinks` writes a "related" block at the end of notes from their links. It is a dry run unless you pass `--write`.

## tv

A channel of video episodes that live in your vault (rendered by whatever you like). The page plays them in order, with a kiosk mode for a TV; pair it with `addons/tv-kiosk/`.

| | |
|---|---|
| Page | `/tv` |
| Settings | `tv.episodesDir`, `tv.shows` in `secondbrain.json` |

## voice

A Listen button that reads a note aloud through a local OpenAI-compatible speech server (for example Kokoro). Local only: never mounted on a server.

| | |
|---|---|
| Settings | `TTS_URL`, `TTS_MODEL` |

## livestream

A poller that checks your channels every minute and writes a public summary JSON (viewers, hours streamed), served by Caddy under `/public/` with no login. It contains no private data.

| | |
|---|---|
| Settings | `livestream.youtube`, `.twitch`, `.kick` in `secondbrain.json` |
| Timers (server) | the minute poller |
| Skill | `livestream-x` (adds an X stream by link) |

## ring

Stores data from a wearable ring that a separate client pushes in, next to your notes.

| | |
|---|---|
| Page | `/ring` |
| CLI | `secondbrain ring-pull` (mirror a server's ring tables) |
| Settings | `RING_PULL_SSH_HOST`, `RING_PULL_DB` |

## social

Connects your own LinkedIn account (self-service "Share on LinkedIn" permission, no app review) and publishes queued posts, with images, on a schedule. No web page yet: connect through the API (`GET /api/social/accounts/linkedin/connect`) and queue with `cli-social queue` or `POST /api/social/posts`; a compose UI is a planned follow-up.

Images (JPEG, PNG or GIF, up to 5 MB each, 4 per post, alt text required) are stored as bytes in `social_post_media`, so a post can be queued from any machine that reaches the database and the server's timer always has the file. At publish time each image goes through LinkedIn's Images API (initialize upload, PUT the bytes), then the post refers to the image URNs; a failed upload fails the attempt before any post is created. A run starts no new post after 40 s; a post left `publishing` by a killed run is marked `failed` after 15 minutes (never requeued, since LinkedIn may already have it). The 3,000-character limit is checked on the escaped text. Post text is escaped into LinkedIn's "little" text format, so `( ) * _ @` and the like show as typed instead of cutting the post short, and `#word` stays a hashtag.

A standard LinkedIn app gets a 60-day access token and **no refresh token** (LinkedIn only issues those to Marketing Developer Platform partners). Without that approval, reconnecting every ~2 months is expected, not a bug: the minute timer pings Telegram once when an account's access token is within 7 days of expiring with nothing left to refresh it.

| | |
|---|---|
| API | `GET/DELETE /api/social/accounts`, `GET /api/social/accounts/:provider/connect` + `/callback`, `GET/POST/DELETE /api/social/posts` |
| CLI | `cli-social` (on the app user's PATH): no command = one pass (publish due posts, then the reauth check); `accounts`, `posts [--status S]`, `queue --body-file F [--image P --alt T]... [--account ID] [--at ISO]`, `cancel ID` |
| Settings | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `SOCIAL_REDIRECT_BASE_URL`, `SOCIAL_TOKEN_ENC_KEY` |
| Timers (server) | the minute publisher/reauth-check (`secondbrain-social`) |
| Design | `Projects/secondbrain-app/social-linkedin-plan.md` in the vault |
| OAuth callback | Served before the login check (the session cookie is SameSite=Strict, so LinkedIn's redirect arrives without it); the one-time `state` from a logged-in `/connect` guards it |

## calendar

Events live in notes, so the note that explains a trip or a meetup is also the record of when it happens. Put a table between two comments anywhere in a note:

```
<!-- calendar tz=Asia/Kolkata -->
| Date | Start | End | Event | Where | Link |
|---|---|---|---|---|---|
| 2026-11-03 to 2026-11-06 | | | Devcon 8 | Jio World Centre | https://devcon.org |
| 2026-11-03 | 09:00 | 18:00 | Opening day | Main hall | |
<!-- /calendar -->
```

Columns are matched by header name in any order: `Date` and `Event` (or `Title`) are required; `Start`, `End`, `Where` (`Venue`, `Location`) and `Link` (`URL`) are optional. A date can be a range (`2026-11-03 to 2026-11-06`). Times are wall-clock in the block's `tz` (an IANA zone; UTC when missing or unknown), and a row with no start time is all day. A row with an impossible date or time is skipped and counted on the page, never guessed. A `[text](url)` in the Event cell becomes the event's link.

| | |
|---|---|
| Page | `/calendar`: month grid (weeks start Monday), agenda for the month or a clicked day, times in each event's own zone, a link back to the note |
| API | `GET /api/calendar` (`from`, `to` optional), `GET /api/calendar/ics` (an iCalendar file: timed events in UTC, all-day events as dates) |
| Source | The index (`vault_files.body`), so an edit shows after the next scan |
| Settings, timers | none |

## Adding a module

A new optional feature is a new module, off by default. The checklist is in [`../CONTRIBUTING.md`](../CONTRIBUTING.md#adding-a-module).
