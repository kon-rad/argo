# Media schedule

A content calendar per brand, under Work > Media schedule (needs the `social` module). Route: `/media-schedule?brand=<slug>&view=month|week|list&date=YYYY-MM-DD` (add `&canceled=1` to show canceled posts, `&post=<id>` opens the side panel).

## Brand config

Brands are listed in the vault's `secondbrain.json`:

```json
"media": { "brands": [ { "slug": "argo", "config": "media/media-brand.md" } ] }
```

The config file's front matter is the source of truth; the body is prose for people. The content skills can read the same file.

```yaml
---
brand: argo
name: Argo
tracker_projects: [some-project]
style_guides: [media/style/long-form.md]      # apply to every channel
channels:
  - id: instagram
    network: instagram
    handle: "@example"
    url: https://www.instagram.com/example/
    posting: buffer            # buffer | direct | manual
    account_id: 4              # a social_accounts id; required unless manual
    style_guide: media/style/reel.md
  - id: blog
    network: web
    url: https://example.com/blog
    posting: manual            # no account_id; listed, not on the calendar (v1)
    files: media/blog/
---
```

Rules the server enforces when it loads a file (a brand that breaks one becomes an error card naming the file and line; the other brands still render):

- An `account_id` belongs to at most one channel across all brands.
- `buffer` and `direct` need an `account_id` that exists in `social_accounts`; `manual` must not have one. A disconnected account is allowed and shows as disconnected.
- Channel ids are unique within a brand, and the file's `brand` must match its slug in `secondbrain.json`.
- A missing style guide is shown as a broken link with a warning, not dropped. `url: verify` (or `status: verify`) shows the channel without a link and with a warning.
- Paths must stay inside the vault.

## API

- `GET /api/media/brands`: every brand, parsed, with each channel's account health (connected, token expiry for direct accounts). A broken brand is `{ ok: false, error: { file, line, message } }`.
- `GET /api/media/brands/:slug/calendar?from&to`: posts whose account belongs to one of the brand's channels, in `[from, to)` (at most 120 days), each tagged with its channel, plus per-channel counts for the range. 422 with the error detail when the brand file is broken.
- `GET /api/social/posts` takes `from`, `to`, `status` and `account_ids` (comma-separated) and returns `card_id` and `source_path`.
- `POST /api/social/posts` accepts optional `cardId` (`t_` plus hex) and `sourcePath` (a vault-relative path).
- Approve and cancel on the page call the existing `POST /api/social/posts/:id/approve` and `DELETE /api/social/posts/:id`. The app has one owner login, so there is no separate non-owner session to refuse.

## Data

Migration `1756000014600` adds `social_posts.card_id` and `social_posts.source_path` (both nullable) and an index on `(account_id, scheduled_for)`. `cli-social queue` takes `--card <id>` and `--source <vault path>`.

## Not in v1

Editing copy, drag to reschedule, connecting channels, analytics, putting manual channels on the calendar, recurring cron entries. The card chips show an id without a title when the agent hub does not answer.
