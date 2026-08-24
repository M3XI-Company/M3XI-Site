# Video: full generation, the Editor, and the public Library

Three things shipped together (23 Aug 2026).

## 1. Generation is no longer fixed at 16:9 / 5s

`m3ix-generate` already accepted an `aspect` parameter and defaulted it to
`16:9`; nothing ever sent one, and `duration` was the string `"5"`, hard-coded.
Every vertical video therefore had to be centre-cropped afterwards from
1920x1080 down to 608x1080 — two thirds of every frame thrown in the bin.

Now:

* **Shape** — `9:16`, `16:9`, `1:1`, chosen in the Studio, sent as `aspect`.
  Only applied on the text-to-video path: image-to-video takes its frame shape
  from the reference image, and Kling rejects the pair.
* **Length** — 5s or 10s, sent as `duration`.
* **Cost follows length.** A 10s clip is billed at `COST_VIDEO * 2` (120 by
  default). The provider bills by the second; charging 60 either way was a loss
  on every long generation.

Both are clamped, not validated — an unrecognised value falls back to the old
default rather than failing a generation the customer has already paid for.

### A bug fixed on the way through

`video_submit` was appending the **world** scene-director paragraph to every
video prompt:

> "— a complete, coherent world in every direction: continuous ground with no
> missing patches or holes, every building closed on all sides… game-environment
> completeness."

That text belongs to `world_submit` and had been copied into the video branch.
Every clip generated in the Studio was quietly asking Kling for a complete game
environment. Video prompts now go to the provider exactly as written.

## 2. The Editor — `/studio/editor.html`

A timeline over clips that already exist. It generates nothing.

* **Timeline** — multi-clip, drag to reorder, red handles to trim, split at the
  playhead, duplicate, delete, speed from 0.25x to 3x.
* **Transitions** — cut, crossfade, dip to black, whip pan. A transition does
  not add time, it *overlaps* the two clips either side, so adding one shortens
  the video. `layout()` is the single place time is decided; the ruler,
  playhead and exporter all read from it.
* **Effects** — fit (cover / contain / blurred fill), Ken Burns zoom with
  separate start and end scale, six colour looks, vignette, camera shake.
* **Audio** — music and voiceover tracks with volume, fade in/out, and ducking
  under any clip that has its own sound. Silent clips are detected and ignored,
  so a generated clip never opens a ducking window or burns an AAC stream.
* **Canvas** — 9:16, 16:9 or 1:1. Clips are fitted, never squashed.

Keyboard: space play/pause, `s` split, arrows step one frame (shift for a
second), delete removes the selected clip.

### Export happens in the browser

Deliberately. An export costs nothing per run and needs no render
infrastructure, which is what lets a video stay priced at 60 credits.

1. **WebCodecs → MP4** (`mp4-muxer` from jsDelivr). Frame-accurate: every output
   frame seeks its sources, draws, and encodes. H.264 plus AAC.
2. **MediaRecorder → WebM.** Used when WebCodecs is missing (Safari, older
   Firefox) *or* when the muxer CDN cannot be reached. Real-time, so a 30s video
   takes 30s.

The preview and the export call the same `renderTo()`. If they ever diverged,
what you exported would stop matching what you approved.

**Accounts load lazily.** Supabase is imported on demand, inside the two
functions that need it. It used to be a top-level import, which meant one
unreachable CDN took the entire editor down — including work already on the
timeline.

### Not yet verified

The **WebCodecs MP4 path has not been run end to end.** It was tested in a
headless Chromium built without proprietary codecs, so no H.264 encoder existed
and every run fell through to the MediaRecorder path — which *is* verified
(1080x1920, audio mixed, 2.5 MB out). Open the editor in real Chrome, export
anything, and confirm you get an `.mp4` rather than the "MP4 encoder
unavailable" line in the log.

## 3. The Library takes video

`m3ix_videos` plus four actions on `m3ix-generate`: `video_publish`,
`video_list`, `video_mine`, `video_queue` / `video_moderate`.

**Publishing does not go live.** Rows land as `pending`. Only an approved row is
readable by the public, and only an address in `M3IX_ADMINS` can approve one.
The table has no client `INSERT` or `UPDATE` grant at all, so nobody can POST
`status='approved'` straight to PostgREST and skip the queue.

Files are re-hosted into our own `videos` bucket before publishing. Provider
URLs belong to fal, not to us, and the site has already been bitten once by
depending on them for world covers.

## Deploy status

**Supabase is done** (24 Aug 2026, project `tnlcuptfldwxtxajudoq`):

* migration `video_library` — `m3ix_videos`, indexes, RLS, `m3ix_video_viewed`
* migration `video_library_storage` — the public `videos` bucket + object policies
* `m3ix-generate` **version 20**, ACTIVE, `verify_jwt` still true

Verified live: `video_list` returns `{"videos":[]}` to the anon key;
`video_publish` and `video_queue` both refuse with 401 when signed out; the
table reports 0 INSERT/UPDATE/DELETE grants to `anon` or `authenticated`, so
the approval queue cannot be walked around.

**Still to do — the site itself:**

```bash
git add studio/ vite.config.js supabase/ docs/VIDEO_EDITOR.md
git commit && git push                    # Vercel builds the editor page
```

Until that push, `/studio/editor.html` is not live and the Studio page has no
shape/length buttons — the backend is simply ahead of the front end, which is
harmless.

Optional: set `M3IX_ADMINS` in Supabase secrets (comma-separated emails). It
defaults to `admin@m3xi.com`, so the queue is never unreviewable.

There is no moderation UI yet — approve from the SQL editor or curl:

```sql
update m3ix_videos set status='approved', reviewed_at=now() where id='…';
```

## A note on the repo before you commit

`git status` currently shows ~40 modified files that nobody edited. They are
**line endings only** — the working tree has CRLF, `HEAD` has LF
(`git diff --ignore-cr-at-eol` on any of them comes back empty). It predates
this work. Commit the specific paths rather than `git add -A`, or the next diff
buries real changes under 19,000 phantom lines. A `.gitattributes` with
`* text=auto eol=lf` would end it.

## Still carrying the same bug in two other places

`video_submit` was fixed. The identical world "scene director" paragraph is
**still appended** in two more handlers:

* `refine` (the Film-mode shot-list writer) — every shot list is asked for
  "game-environment completeness".
* `image` — every generated image asks for continuous ground and buildings
  closed on all sides. This ran on the whole site portfolio.

Both were left alone in this deploy because they change output on endpoints
nobody asked to touch. The fix is the same four lines removed from each.
