# Large uploads

The `uploads` module lets you send a file of 1 GB to 50 GB (`UPLOADS_MAX_GB`) from any browser, phone included, into your vault's Backblaze B2 bucket, filed under a vault folder you choose. Nothing big passes through the app server on the way in.

## How it works

1. **Start.** The page tells the server the file name, size, vault folder and description (`POST /api/uploads`). The server starts an S3 multipart upload on the bucket's plain `inbox/<id>/<name>` key and returns the part size (64 MiB, larger only when the file would need more than 9000 parts).
2. **Send.** The browser asks for presigned part URLs (`POST /api/uploads/:id/parts`) and `PUT`s the parts straight to B2, four at a time. A part that fails is retried with a fresh URL. After a reload or a dropped connection, choosing the same file again asks B2 which parts it already holds (`GET /api/uploads/:id`) and sends only the rest.
3. **Finish.** `POST /api/uploads/:id/complete` makes the server list the parts itself, check each size against the announced file size, and complete the multipart upload. It never trusts ETags from the browser.
4. **File it.** A worker on the server streams `inbox/...` into `vault/<folder>/<name>` with rclone, remote to remote, so no local disk is used. When the bucket's vault part is encrypted (`B2STORE_CRYPT_PASSWORD`), this is the step that encrypts it. The worker then checks the stored size, deletes the inbox copy, and writes `<name>.b2.md` next to where the file belongs in the vault, in the same format as `b2-offload`. The existing media gallery and `/api/b2` streaming play it from B2. A name already in that folder gets `-2`, `-3`.
5. **Copy to the editing machine (optional).** Tick "Also copy to my editing machine" (or press "Copy to the editing machine" later). A small script on that machine, `app/deploy/uploads-pull.sh`, polls `/api/uploads/pull/pending` with `UPLOADS_PULL_TOKEN`, downloads each file with `b2store fetch`, moves it to `~/<uploads.m1Dir>/<vault folder>/` and reports back. A machine that is off simply picks the files up when it is next on.

The folder must start with `Projects`, `Areas`, `Research` or `Archives`. `uploads.destinations` in `secondbrain.json` adds one-tap presets with keywords; the page pre-selects a preset when the file name or description contains one of its keywords.

## Setup

1. Env on the server: `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET`, `B2_S3_ENDPOINT` (for example `https://s3.us-west-004.backblazeb2.com`), `B2STORE_CRYPT_PASSWORD`/`2` if the vault is encrypted, `UPLOADS_PULL_TOKEN`; add `uploads` to `MODULES`. `rclone` must be installed on the server.
2. **A CORS rule on the bucket.** The browser `PUT`s to B2 directly, so B2 must allow it from your app's origin. In the B2 console (Buckets, your bucket, CORS Rules) or with the B2 CLI: allowed origin `https://<your PUBLIC_ORIGIN>`, allowed operations `s3_put` (and `s3_get`), allowed headers `*`, max age 3600. A key that can change bucket settings is needed once; the app key itself does not need that.
3. Optional, on the editing machine: copy `app/deploy/uploads-pull.sh` there, put `UPLOADS_PULL_URL` and `UPLOADS_PULL_TOKEN` in `~/.config/uploads-pull/env`, and run it from launchd every two minutes.

## Failure handling

| What breaks | What happens |
|---|---|
| Browser closes or connection drops mid-upload | The parts B2 already holds stay. Choose the same file again to resume. An upload nobody finishes for 7 days is aborted so B2 stops keeping its parts |
| A part is rejected or lost | Retried up to 6 times with a fresh URL and backoff |
| Filing into the vault fails (rclone error, size mismatch) | Status `failed` with the error; the inbox copy is kept; "Retry filing" runs it again |
| The server restarts while filing | Rows left in `ingesting` go back to `uploaded` at start-up and are filed again |
| The editing machine is off | The row stays "Waiting for the editing machine"; nothing falls back to another machine |

## Security

Part URLs are valid for six hours, each for one part of one object. The B2 key stays on the server. The pull route accepts only the bearer token and can list pending files and report status; it cannot read file bytes. Folder and file names are sanitised (no `..`, no path separators in a name, no `.b2.md`).
