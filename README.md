# desktop-comfyui-server

<img src="src-tauri/icons/128x128.png" width="88" align="right" alt="" />

Download Setup from releases
セットアップファイルをreleasesからダウンロードして使用してください。
このアプリは開発中のためご使用は自己責任でお願いします。

# Screenshot
<img width="1007" height="791" alt="image" src="https://github.com/user-attachments/assets/e23c64e4-981c-4d70-9e1d-3b5479b12ca5" />
<img width="1006" height="792" alt="image" src="https://github.com/user-attachments/assets/e6cacfad-ed85-4287-b417-c8192ba59cb0" />
upstream server setting
<img width="774" height="374" alt="image" src="https://github.com/user-attachments/assets/cac74acb-4b12-4d5c-82c5-c5881a9bf2a8" />

## What it is

A desktop app that lends your GPU to a job server. It polls one or more job
servers for queued work, runs each job through a ComfyUI workflow you exported
yourself, uploads the result, and starts and stops ComfyUI on this machine so
the GPU is free when you want it back.

It sits in the tray. Close the window and it keeps working; the tray menu is
enough to stop ComfyUI or stop taking new jobs without opening anything.

- **Your workflows, not bundled ones** — export a workflow from ComfyUI and the
  app reads the graph to find the prompts, seed, length and input image
- **Runs ComfyUI for you** — one button, with the tail of its output when the
  command is wrong, and a watchdog that restarts a ComfyUI that crashes
- **Any job server** — the protocol is a handful of HTTP endpoints, documented
  below. Link a server with a one-time code, or type its credentials in
- **Standalone too** — with no server attached it still manages ComfyUI and
  shows what it is doing
- **English and Japanese**, light and dark, remembered per browser

The window is a web page served by a plain [Bun](https://bun.com) server in
`src/`; the desktop shell in `src-tauri/` starts that server and opens a window
onto it. Both talk over the same HTTP API, so the server also runs on its own,
on a headless box or from source.

## Install

### The desktop app (Windows)

Download the `*-setup.exe` from
[Releases](https://github.com/mintani/desktop-comfyui-server/releases) and run
it. It installs for the current user, so there is no admin prompt, and it
fetches WebView2 if the machine does not already have it.

You also need a [ComfyUI](https://github.com/comfyanonymous/ComfyUI) install —
the app runs yours, it does not ship one.

Installing is a one-time job: the app checks this repository's releases when it
starts and once a day after that, asks before installing anything, and restarts
into the new version. **Check for updates** in the tray menu does the same on
the spot. Updates are signed, and the app refuses one whose signature does not
verify.

Settings, job history and uploaded workflows go to
`%APPDATA%\desktop-comfyui-server`.

**The installer is not code signed**, so Windows shows *"Windows protected your
PC"* — choose **More info → Run anyway**. Signing needs a paid certificate;
until there is one, every download will do this, and it says nothing about what
is inside. What you can check instead:

- Everything the app runs is in this repository. There is no separate download
  and no telemetry — it only talks to your ComfyUI and to job servers you add
  yourself.
- The installers are built by GitHub Actions from the released commit, not
  uploaded from anyone's machine. The build log for each release is public.
- It contains exactly two programs: `desktop-comfyui-server.exe`, the window,
  and `comfyui-server.exe`, the server from `src/`. The size is the Bun runtime
  compiled into the second one.

### From source (any OS)

The server runs without the desktop shell. Needs Bun 1.3 or newer and nothing
else — there are no runtime dependencies.

```bash
bun install
cp .env.example .env    # optional; the defaults work locally
bun start
```

Open <http://127.0.0.1:3939>. Everything below works the same, minus the tray
and the settings that belong to it.

Every variable is optional. See [`.env.example`](.env.example) for the full list
with comments; the ones you are most likely to touch:

| Variable      | Default                 | Meaning                                    |
| ------------- | ----------------------- | ------------------------------------------ |
| `COMFY_URL`   | `http://localhost:8188` | ComfyUI on this machine                    |
| `COMFY_DIR`   | unset                   | where ComfyUI is installed                 |
| `UI_PORT`     | `3939`                  | management UI port                         |
| `UI_HOSTNAME` | `127.0.0.1`             | set to `0.0.0.0` to reach it from the LAN  |
| `UI_TOKEN`    | unset                   | shared secret for the UI                   |
| `WORKFLOW`    | first file found        | workflow used at startup                   |
| `UI_ENABLED`  | `true`                  | set `false` to run headless                |
| `DATA_DIR`    | this directory          | where workflows and state are written      |

`COMFY_DIR` and the `SERVER_n_*` blocks only seed the settings file. Once you
save either from the UI the stored value takes over and the variable is ignored.

The desktop app sets `DATA_DIR`, `UI_PORT` and `UI_TOKEN` itself, so these
matter only when running from source. **Set `UI_TOKEN` before changing
`UI_HOSTNAME`** — see [Who can reach the UI](#who-can-reach-the-ui).

## Using it

### The window

One tab per subject, so the thing you came to change is a click away rather
than somewhere down a long page.

**Workflows** is where it opens: add a workflow, see what each one exposes,
choose the one used for jobs that do not name one, delete the ones you are
done with.

**ComfyUI** points the app at your install — where it is, and optionally the
command to run there — and starts and stops it, with the tail of its output so
a wrong command explains itself. A ComfyUI started here that crashes is started
again on its own; three crashes in a row right after starting read as a broken
command, so it stops trying and says why in the log. An *Outputs* panel shows
how much disk ComfyUI's output folder holds, with a button — and an optional
standing rule — that deletes files older than a chosen number of days.

**Servers** attaches job servers: link one with a code from its own UI, or fill
a row in by hand; reorder and disable them here too. The order is the priority.

**Accepting** says when job servers get work out of this machine — a hold for
the next while, or a daily window.

**Runs** is the history: every job claimed from a job server, narrowed by state
and flipped into a gallery of everything the filtered runs produced. *Interrupt*
asks ComfyUI to abort the run in flight.

A run in flight carries a bar — the steps ComfyUI has done out of the steps it
expects, and the node it is on — so a slow workflow can be told from a stuck
one, and the status bar carries the percentage on every page.

The header switches the theme and the language, and the button beside them opens
the app's own settings — the same switches the tray menu carries.

### What this machine will start

Beside *Start ComfyUI* is a dot with three states, picked the way a chat app
picks a presence.

| | | Jobs from a job server | ComfyUI |
| --- | --- | --- | --- |
| 🟢 | **Accepting** | yes | left alone |
| 🟡 | **Not accepting** | no | left alone |
| 🔴 | **Stopped** | no | shut down |

*Not accepting* is the one worth knowing about. It stops the queue without
disconnecting from anything: job servers still see the machine, they just get
nothing from it until you switch back, and ComfyUI stays up for whatever you
want to do with it yourself.

*Stopped* is the heavy one. It shuts ComfyUI down to give the GPU back, which
takes the running generation with it, so it asks before it does.

All three say what ComfyUI is to do, so the picker is greyed out until ComfyUI
is up: start it first, then say what it takes on. A machine whose ComfyUI is not
answering claims nothing from a job server either, whatever its state says.

The same three are in the tray, so it can be changed with the window closed.

### When it accepts

*Accepting* does not have to mean right now. On the Accepting page:

- **Hold off for** 15, 30 or 60 minutes. The machine stops taking jobs and
  starts again on its own, which is what you want when the GPU is yours for the
  next half hour and remembering to switch back is the hard part.
- **Every day, only between two times.** 02:00 to 08:00 lends the GPU out
  overnight. An end before the start crosses midnight, so that window is tonight
  until tomorrow morning rather than an error.

Both only hold jobs back. ComfyUI stays up and job servers still see the
machine — they simply get nothing out of it until the hold is over. The header
says which of the two is holding it and the status bar says how much is left.

A hold is stored with its end time rather than counted down in memory, so
restarting the app in the middle of one does not start claiming early.

### The tray

Closing the window does not stop anything. The app stays in the tray with:

| Menu item | What it does |
| --------- | ------------ |
| **Open** | brings the window back |
| **Generation** | the three states above, *Stopped* asking first |
| **Stop ComfyUI** | stops the ComfyUI this app started |
| **Check for updates** | asks GitHub for a newer release now |
| **Quit** | stops the app and its server |

Two things are set from the app's settings button rather than the tray:

- **Start when the computer starts**
- **Closing the window** — keep running in the tray, or quit

Both are stored with everything else, so the tray and the page always agree.

### Pointing it at ComfyUI

On the ComfyUI page, put the folder in *Directory*:

| What you installed | What to enter | What gets run |
| ------------------ | ------------- | ------------- |
| ComfyUI portable | the folder holding `python_embeded` | `python_embeded\python.exe -s ComfyUI\main.py` |
| A git clone with a venv | the folder holding `main.py` | `.venv\Scripts\python.exe main.py` |
| Anything else | the folder to run in | whatever you put in *Start command* |

Quote a path that has a space in it. Leaving *Start command* blank means "work
it out from the directory".

If ComfyUI is already running when the app starts, that is fine — the app
notices it and simply does not claim to have started it. Only a ComfyUI the app
launched can be stopped from the app.

### Bring your own workflow

In ComfyUI, turn on **Settings → Lite Graph → Enable Dev mode options**, then
use **Workflow → Export (API)**. Upload the JSON on the Workflows page.

ComfyUI's API format is a flat map of node id to node, and each node records its
class and how its inputs are wired. That is enough to find the interesting
inputs without being told:

| Parameter   | How it is found                                                       |
| ----------- | --------------------------------------------------------------------- |
| `image`     | the first `LoadImage`-style node                                      |
| `positive`  | follow a sampler's `positive` link back to the node holding the text  |
| `negative`  | same, via the `negative` link                                         |
| `seed`      | every node with a `seed` / `noise_seed` input, all set together       |
| `length`    | a node with a numeric `length` input (frame count on video workflows) |
| `frameRate` | a node with a numeric `frame_rate` input                              |

The Workflows page shows which of these were found, so a workflow that needs
help is obvious before a job server sends work. A parameter whose slot was not
found is simply ignored — a workflow with no `LoadImage` takes no input image.

*Check* on a workflow's row goes further: it asks the running ComfyUI — via
`/object_info` — whether every node type in the file exists there, and whether
every file-choosing input (checkpoints, LoRAs, VAEs, …) names something
actually installed, without running anything. Inputs the app replaces at run
time, the input image above all, are left out of the check.

Outputs are not detected in advance. Whatever ComfyUI records in its history for
the run is collected, so images, videos and gifs all work with no configuration.

Values are collected the same way. A node that reports something other than a
file — ComfyUI's own *Preview as Text*, a tagger's tag list, a similarity score
— lands in the same history, and the app hands it to the job server as JSON.
That is how a workflow that compares two images and answers with numbers
returns its verdict; see [Result, complete, fail](#result-complete-fail). Give
such a node a title in ComfyUI (double-click its header): the title is how the
server tells one value from another.

When detection gets it wrong, put the mapping in a sidecar named after the
workflow, `<workflow>.slots.json`, beside it in the workflows folder:

```json
{
  "positive": { "nodeId": "129:93", "input": "text" },
  "negative": { "nodeId": "129:89", "input": "text" },
  "seed": [{ "nodeId": "129:86", "input": "noise_seed" }]
}
```

Only the keys you list are overridden. Set one to `null` to switch that
parameter off. An override naming a node that isn't in the workflow is an error,
reported in the UI rather than silently ignored.

## Attaching a job server

Left alone, the app only manages ComfyUI. Add a server on the Servers page and
it polls for queued jobs, runs them through the active workflow and uploads the
result — which is the point of the tray: the machine keeps serving with nothing
on screen.

There are two ways to add one:

- **Link.** The job server's own UI issues a short-lived, one-time code. Paste
  the server's URL and that code, and the app fetches its host id and secret
  from the server itself; nothing secret is shown or copied by hand. Linking a
  URL that is already in the list replaces that row's credentials.
- **By hand.** Type the URL, host id and secret the server gave you.

The URL has to be `https://`. Plain `http://` is accepted only for this machine,
a private network address or a name without a domain (`http://nas:8080`),
because the secret is sent as a bearer token on every request and the produced
files travel the same way.

Adding a server is an act of trust. A job can carry its own workflow, and that
workflow runs on your ComfyUI with every custom node you have installed, so a
server you attach can do whatever those nodes can do. Attach servers you run or
know.

Each row has a *Test* button. It sends one heartbeat there and then, so a wrong
secret answers `HTTP 401` immediately instead of looking like an unreachable host
until the next beat. It tests what is on screen, so a secret you have typed but
not saved is the one tried; leaving the box blank tests the stored one.

Several can be served at once. They are asked in the order the list puts them,
so the top of the list is the priority: a server with work queued keeps this
machine until it runs dry, and only then does the next one get a turn.

Because ComfyUI is a single machine, jobs are always run one at a time. Switch
to *Not accepting* and nothing more is claimed, while the job in flight
finishes.

Any server that implements the protocol below works.

## Job server protocol

This is what the app speaks to a job server. Every request is sent by the app;
the server only answers. All paths except `link` sit under
`/api/internal/hosts/:hostId` and carry `Authorization: Bearer <hostSecret>`.
Bodies are JSON unless noted. Any non-2xx answer is a failure; where the server
has a reason, `{ "error": "…" }` is the shape the app knows how to show.

| Method | Path                       | Body sent                          | Answer expected                        | Timeout | When                          |
| ------ | -------------------------- | ---------------------------------- | -------------------------------------- | ------- | ----------------------------- |
| POST   | `/api/internal/hosts/link` | `{ code }`                         | `{ hostId, hostSecret, hostName? }`    | 15 s    | once, from *Link*             |
| POST   | `/heartbeat`               | `HostStatus` (below)               | `{ pendingJobs? }`                     | 10 s    | every 30 s, and from *Test*   |
| POST   | `/jobs/claim`              | —                                  | `ClaimedJob` (below), or `204` if idle | 10 s    | every 5 s while accepting     |
| POST   | `/jobs/:jobId/result`      | the produced file, raw             | any 2xx                                | 120 s   | after a run that made a file  |
| POST   | `/jobs/:jobId/complete`    | `{ data }` (below)                 | any 2xx                                | 10 s    | after `result`, or at once    |
| POST   | `/jobs/:jobId/fail`        | `{ reason }`                       | any 2xx                                | 10 s    | when a run gives up           |
| GET    | `/manifest`                | —                                  | `Manifest` (below), or `404`           | 15 s    | at start, then every 10 min   |
| PUT    | `/object-info`             | ComfyUI's `/object_info` JSON      | any 2xx, or `404`                      | 60 s    | with the manifest sync        |

`manifest` and `object-info` are optional: a `404` from either is taken as "this
server does not do that" and nothing is logged. The other six are the protocol;
without `link` the server can still be added by hand.

### Heartbeat

```jsonc
{
  "comfyStatus": "available",       // "available" | "busy" | "unavailable"
  "queueRunning": 0,
  "queuePending": 0,
  "gpu": {                          // null when ComfyUI is down or has no GPU
    "name": "NVIDIA GeForce RTX 4090",
    "vramTotal": 25757220864,       // bytes
    "vramFree": 21474836480
  },
  "readyModels": ["checkpoints/foo.safetensors"]   // see Manifest; absent from *Test*
}
```

Heartbeats keep going whatever the run mode says, so the server always sees
whether the host is alive; the mode only decides whether `claim` is called. The
answer's `pendingJobs`, if present, is shown in the UI.

### Claim

`204 No Content` means nothing to do. Otherwise:

```jsonc
{
  "jobId": "…",
  "userId": "…",
  "sourceImageBase64": "…",              // "" for no input image
  "sourceImageContentType": "image/png",
  "params": {                            // optional; every field optional
    "positivePrompt": "…",
    "negativePrompt": "…",
    "seed": 42,
    "seconds": 5,
    "fps": 16
  },
  "workflow": "my-video"                 // optional, see below
}
```

`workflow` picks what runs:

- **absent or `null`** — the workflow marked active on the Workflows page.
- **a string** — a workflow file of that name in the host's workflows folder.
- **an object** `{ "presetId", "workflowJson", "triggerWords" }` — the server
  ships the workflow itself. `workflowJson` is an API-format workflow as a
  string; before it is queued the host replaces the literal input values
  `"__INPUT_IMAGE__"` (the uploaded image's filename), `"__SEED__"` (a random
  seed) and every occurrence of `__TRIGGER_WORDS__` inside a string
  (`triggerWords`, or empty when `null`). `params` is ignored for these.

`params` fields are written into the slots detected in a local workflow; a field
whose slot the workflow lacks is dropped. `seconds` becomes a frame count using
`fps`, falling back to the workflow's own frame rate and then to 16. A missing
`seed` is randomised.

A job runs once on this machine for a server-shipped workflow and up to three
times for a local one (transient failures are retried here, 10 s apart, before
the server hears anything). A single run is abandoned after 10 minutes.

### Result, complete, fail

When a run succeeds the host picks one file — a video if the run produced one,
otherwise the first output — and `POST`s its bytes to `/jobs/:jobId/result` with
the `Content-Type` ComfyUI served it with. Then it calls `/complete` with

```jsonc
{
  "data": [
    { "nodeId": "12", "label": "ccip", "values": { "text": ["0.87"] } },
    { "nodeId": "15", "label": "WD14 Tagger", "values": { "tags": ["1girl, solo, smile"] } }
  ]
}
```

`data` is everything the run's nodes reported besides files, as ComfyUI wrote it
into the history: one entry per node, `label` the node's title in the workflow
(its class when it has none), `values` each key the node reported — a *Preview
as Text* node's `text`, a tagger's `tags` — with its list of values. Nothing is
parsed or converted on the way: a score previewed as text arrives as the string
`"0.87"`, and what it means is between the workflow and the server. `data` is
`[]` when the run reported nothing but files, so a server that only stores
pictures can ignore the body.

A run that reported values and no file at all — a workflow that scores two
images rather than drawing one — skips `/result` and goes straight to
`/complete`. A run that produced neither fails.

If `result` or `complete` is refused, the job is reported to `/fail` instead, so
a server never sees a job stay assigned forever.

`/fail` carries `{ "reason": "<message>" }`, the same text the Runs page shows.

### Manifest

A server that wants jobs to run against particular model files can publish
them. The host downloads what it lacks into ComfyUI's `models/<dest>/<filename>`,
verifies the SHA-256, and from then on lists that model in every heartbeat's
`readyModels` as `"<dest>/<filename>"`. A server can use that list to hand a
preset only to hosts that hold its models.

```jsonc
{
  "presets": [
    {
      "id": "anime-v1",
      "name": "Anime v1",
      "models": [
        {
          "filename": "foo.safetensors",
          "url": "https://…/foo.safetensors",
          "sha256": "<64 hex chars>",
          "sizeBytes": 2132625894,
          "dest": "checkpoints"           // a folder directly under models/
        }
      ]
    }
  ]
}
```

`filename` and `dest` must be single path segments; anything with a separator
or made of dots is rejected. `PUT /object-info` follows the same sync and
carries ComfyUI's `/object_info` verbatim (several megabytes), only when its
content changed, so a server can build a workflow editor's node palette from
what the host actually has installed.

## Implementing *Link* in your own job server

*Link* exists so a person never handles the host secret. Your server's UI shows
a code; the person pastes it, with your URL, into the app; the app exchanges the
code for credentials over the network and stores them. Three pieces:

**1. Issue a code.** When someone adds a host in your UI, create the host record
(a fresh `hostId`, a display name) and a code for it. The code is what a person
reads off a screen and types, so keep it short — six to eight characters from an
unambiguous alphabet is plenty when it expires quickly. Store the code, its
`hostId`, an expiry (ten minutes is generous) and a used flag. Show the code
and your server's base URL.

**2. Answer `POST /api/internal/hosts/link`.** It is unauthenticated: the code
is the credential.

```jsonc
// request
{ "code": "K7M2-Q9XD" }

// 200
{ "hostId": "host_01HZ…", "hostSecret": "<random, ≥ 32 bytes, hex or base64>", "hostName": "studio-pc" }

// 4xx — the app shows `error` to the person verbatim
{ "error": "that code has expired" }
```

Look the code up; refuse it when unknown, expired or already used, and mark it
used in the same step as you read it so two hosts cannot both claim one. Then
generate the secret, store only a hash of it against the `hostId`, and return
the secret once in this response. `hostName` is optional; when present the app
shows *linked as \<hostName\>* and otherwise falls back to the URL's host.

Rate-limit this endpoint by client address — a short code is only safe because
guessing is slow and the code dies in minutes.

**3. Check the secret everywhere else.** Every request under
`/api/internal/hosts/:hostId/…` carries `Authorization: Bearer <hostSecret>`.
Hash the bearer, compare it to the stored hash for that `hostId` in constant
time, and answer `401` on a mismatch — the app's *Test* button surfaces that
status directly, which is how a person tells a wrong secret from a wrong URL.

Serve the whole thing over HTTPS. The app refuses a plain `http://` URL unless
it points at loopback, a private network address or a name without a domain,
because the secret travels as a bearer token on every call and the produced
files travel with it.

What the app does after linking: it saves the row (replacing the credentials of
an existing row with the same URL), restarts its agent, and starts heartbeating
and claiming immediately.

## Management API

The window is a client of this API and nothing more, so anything the window can
do a script can do. It is served on `UI_HOSTNAME:UI_PORT`
(`127.0.0.1:3939` by default; the desktop app picks a free port at launch).

Every `/api/*` request passes the checks in [Who can reach the
UI](#who-can-reach-the-ui): a `403` for a disallowed `Host` or a cross-site
request, a `401` when `UI_TOKEN` is set and missing. A script sends the token
as `Authorization: Bearer <token>`. The page sends it as the `HttpOnly` cookie
that `POST /api/session` sets, so an `<img>` needs no header and no URL carries
the token.

Errors are `{ "error": "<message>" }`, status `400` unless noted. Bodies are
JSON unless noted. Anything not listed is `404`.

| Method | Path                       | Request                                              | Response                                   | Notes                                                        |
| ------ | -------------------------- | ---------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------ |
| GET    | `/`                        | —                                                    | the page                                   | not guarded; static markup                                   |
| GET    | `/api/state`               | —                                                    | `State` (below)                            | everything the page shows, polled                            |
| POST   | `/api/session`             | — (token as `Authorization: Bearer`)                 | `{ ok: true }` + `Set-Cookie`              | trades the token for an `HttpOnly; SameSite=Strict` cookie   |
| POST   | `/api/workflows/upload`    | multipart: `workflow` (file), `name` (optional)      | `{ workflow: WorkflowSummary }`            | refuses non-API-format JSON                                  |
| POST   | `/api/workflows/active`    | `{ name }`                                           | `{ activeWorkflow }`                       |                                                              |
| POST   | `/api/workflows/check`     | `{ name }`                                           | `{ ok, problems: string[], checkedNodes }` | needs ComfyUI up                                             |
| POST   | `/api/workflows/delete`    | `{ name }`                                           | `{ ok: true }`                             | removes the sidecar too                                      |
| POST   | `/api/workflows/reload`    | —                                                    | `{ ok: true }`                             | drops the parse cache                                        |
| POST   | `/api/upstreams`           | `{ upstreams: UpstreamInput[] }`                     | `{ upstreams: PublicUpstream[] }`          | whole list; order is priority; blank `secret` keeps stored   |
| POST   | `/api/upstreams/test`      | `UpstreamInput`                                      | `{ ok, ms, pendingJobs?, error? }`         | one heartbeat, now                                           |
| POST   | `/api/link`                | `{ url, code }`                                      | `{ upstreams, hostName, replaced }`        | `url` must start with `http://` or `https://`                |
| POST   | `/api/settings`            | `{ comfyDir?, comfyCommand?, outputCleanupDays? }`   | `{ settings }`                             | only the fields sent change                                  |
| POST   | `/api/comfy/start`         | —                                                    | `{ ok: true }`                             | error when already running or unconfigured                   |
| POST   | `/api/comfy/stop`          | —                                                    | `{ ok: true }`                             | `500` on failure                                             |
| POST   | `/api/interrupt`           | —                                                    | `{ ok: true }`                             | forwards to ComfyUI; `502` when it does not answer           |
| POST   | `/api/outputs/trim`        | `{ days }` 1–3650                                    | `{ removedFiles, removedBytes }`           | deletes now                                                  |
| POST   | `/api/mode`                | `{ mode }`                                           | `{ mode }`                                 | `409` while ComfyUI is unavailable; `paused` stops ComfyUI   |
| POST   | `/api/accept/pause`        | `{ minutes }` 0–1440, `null` or `0` clears           | `{ accepting: AcceptState }`               |                                                              |
| POST   | `/api/accept/schedule`     | `{ enabled?, from?, to? }` (`HH:MM`)                 | `{ accepting: AcceptState }`               | field by field                                               |
| POST   | `/api/desktop`             | `{ autostart?, closeAction? }`                       | `{ desktop }`                              | `closeAction` is `"tray"` or `"quit"`                        |
| POST   | `/api/jobs/delete`         | `{ id }`                                             | `{ ok: true }`                             | `404` for an unknown id                                      |
| POST   | `/api/jobs/clear`          | —                                                    | `{ removed }`                              | running jobs stay                                            |
| GET    | `/api/output`              | `?filename=&subfolder=&type=`                        | the file                                   | proxies ComfyUI `/view`; `type` is `output`, `input` or `temp`; images, video and audio inline, anything else as a download; `502` when ComfyUI does not answer |

### `GET /api/state`

```ts
{
  comfy: {
    url: string;
    comfyStatus: "available" | "busy" | "unavailable";
    queueRunning: number; queuePending: number;
    gpu: { name: string; vramTotal: number; vramFree: number } | null;
    checkedAt: number;                       // ms epoch, like every timestamp here
  };
  comfyProcess: {
    managed: boolean; pid: number | null; startedAt: number | null;
    error: string | null; log: string[];     // last 40 lines of ComfyUI's output
    command: string; dir: string;
  };
  workflows: WorkflowSummary[];
  workflowDir: string;
  activeWorkflow: string | null;
  agent: {
    running: boolean; autoUpdate: boolean;
    upstreams: { name: string; url: string; hostId: string;
                 heartbeat: { ok: boolean; at: number; pendingJobs?: number } | null }[];
  };
  upstreams: PublicUpstream[];
  settings: { comfyDir: string; comfyCommand: string; outputCleanupDays: number };
  outputs: { dir: string; files: number; bytes: number; scannedAt: number } | null;
  mode: "accepting" | "local" | "paused";
  accepting: AcceptState;
  progress: { promptId: string; value: number; max: number; node: string | null; at: number } | null;
  desktop: { autostart: boolean; closeAction: "tray" | "quit" };
  jobs: JobRecord[];                         // newest first, at most 200
  events: UiEvent[];                         // at most 20, oldest dropped
}
```

The shapes it refers to:

```ts
WorkflowSummary = { name: string; valid: boolean; error?: string; nodeCount?: number;
                    slots?: WorkflowSlots; overridden?: string[] };
WorkflowSlots   = { image: Slot | null; positive: Slot | null; negative: Slot | null;
                    seed: Slot[]; length: Slot | null; frameRate: Slot | null };
Slot            = { nodeId: string; input: string; label: string };

UpstreamInput   = { id?: string; name?: string; url?: string; hostId?: string;
                    secret?: string; enabled?: boolean };
PublicUpstream  = { id: string; name: string; url: string; hostId: string;
                    enabled: boolean; hasSecret: boolean };   // the secret itself is never returned

AcceptState     = { accepting: boolean; blockedBy: "mode" | "paused" | "schedule" | null;
                    pausedUntil: number | null;
                    schedule: { enabled: boolean; from: string; to: string } };

JobRecord       = { id: string; source: "ui" | "upstream"; origin?: string; workflow: string;
                    state: "running" | "succeeded" | "failed";
                    startedAt: number; finishedAt?: number; promptId?: string;
                    outputs?: RunOutput[]; data?: RunData[]; error?: string;
                    attempts?: number; interrupted?: boolean };
RunOutput       = { nodeId: string; filename: string; subfolder: string; type: string;
                    kind: "image" | "video" | "audio" | "file"; url: string };
RunData         = { nodeId: string; label: string; values: Record<string, unknown> };

UiEvent         = { id: number; at: number;
                    kind: "job-failed" | "upstream-down" | "upstream-up" | "comfy-crashed"
                        | "comfy-gave-up" | "outputs-trimmed";
                    params: Record<string, string> };
```

`RunOutput.url` points at ComfyUI's `/view`; fetch the same file through
`/api/output` when ComfyUI is not reachable from where you are. `RunData` is
what the run reported besides files, exactly as it went to the job server — see
[Result, complete, fail](#result-complete-fail).

### What it talks to on ComfyUI

For completeness, the ComfyUI endpoints the server uses, all on `COMFY_URL`:
`/system_stats` and `/queue` for status, `/upload/image`, `/prompt`,
`/history/:promptId`, `/view`, `/interrupt`, `/object_info`, and the
`/ws?clientId=` socket for progress.

## Who can reach the UI

The UI can start a process on this machine, so it is worth knowing what protects
it. Binding to `127.0.0.1` is not on its own enough: a page you happen to visit
can make *your* browser post to a local server, and a domain that resolves to
`127.0.0.1` can talk to one as same-origin.

Three checks, in `src/ui/guard.ts`, cover `/api/*`:

| Check | What it stops |
| ----- | ------------- |
| **Host** — only IP literals and `localhost` are answered | a rebound domain name reaching the API |
| **Origin / `Sec-Fetch-Site`** — a cross-site request is refused, reads included | a web page you visited driving this UI, or probing it |
| **`UI_TOKEN`** — off unless set | anyone else on the network |

Requests with no `Origin` at all — `curl`, a script — are allowed through, since
they cannot be a browser being used against its owner.

The page itself is served without these; it is static markup with nothing in it,
and every request it then makes is checked.

The app always sets a fresh `UI_TOKEN` at launch and hands it to its own window
once, so nothing else on the machine can drive it. Running from source, **set
`UI_TOKEN` before changing `UI_HOSTNAME`**: generate one with
`openssl rand -hex 24`, then open the UI once as `http://host:3939/?token=…`.
The page trades it for an `HttpOnly` cookie straight away and clears it from
the address bar, so nothing running in the page can read it afterwards.
Starting with a non-loopback hostname and no token prints a warning at boot.

The page also carries a Content Security Policy that allows scripts, styles,
fonts and requests from this server only. The fonts are bundled, so the page
loads nothing from anywhere else.

Upstream secrets are stored in plain text in `.state.json` under `DATA_DIR`,
the same way `.env` would hold them. The file is written readable by its owner
only; treat it like `.env` all the same.

## Building it yourself

```bash
bun install
bun run app:dev       # build the server, then open the window
bun run app:build     # installers in src-tauri/target/release/bundle
```

Needs [Rust](https://rustup.rs) and Tauri's
[platform prerequisites](https://v2.tauri.app/start/prerequisites/): on Windows
that is the MSVC toolchain and Visual Studio Build Tools with the *Desktop
development with C++* workload; on Linux, `webkit2gtk-4.1` and `librsvg`.

The server is bundled by `bun build --compile`, which carries the Bun runtime,
so the sidecar is about 100 MB before compression.

Installers are built by
[`.github/workflows/release.yml`](.github/workflows/release.yml). A release is
the version in `package.json`: bump it — along with `src-tauri/tauri.conf.json`
and `src-tauri/Cargo.toml`, which have to agree — and when that lands on `main`
the installers appear on a draft release tagged `v<version>`.

To try a build without announcing one, run the workflow by hand from the Actions
tab; the installers come back as workflow artifacts instead.

## Development

```bash
bun run dev           # reload on change
bun run check         # oxlint + oxfmt
bun run check-types   # tsc --noEmit
```

Work starts from an issue and lands on `dev`; `main` holds what has been
released. [`CONTRIBUTING.md`](CONTRIBUTING.md) has the branch, commit and
release steps.

`src/` is the server and the UI, `src-tauri/` is the desktop shell. The two talk
over HTTP like any other client, so the shell holds no state of its own — it
reads what the page saved and applies it.

To add a language, put it in `LANGS` at the top of `src/ui/i18n.ts` and run
`bun run check-types`. Every string that still needs translating is reported
with its line, and the header switch picks the new one up on its own. The tray
menu is English only for now: the page's language lives in the browser, which
the shell cannot read.

## License

MIT
