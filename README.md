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


A desktop app that runs your own ComfyUI workflows, starts and stops ComfyUI
itself, and can hand the GPU to a job server when you are not using it.

It sits in the tray. Close the window and it keeps working; the tray menu is
enough to stop ComfyUI or stop taking new jobs without opening anything.

- **Your workflows, not bundled ones** — export a workflow from ComfyUI and the
  app reads the graph to find the prompts, seed, length and input image
- **Runs ComfyUI for you** — one button, with the tail of its output when the
  command is wrong
- **Standalone or attached** — useful on its own; point it at one or more job
  servers when you want it to serve requests from elsewhere
- **English and Japanese**, light and dark, remembered per browser

## Install

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

### About that Windows warning

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

If you would rather not trust a binary at all, it runs from source — see
[Without the app](#without-the-app).

## The window

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
the next while, or a daily window. [When it accepts](#when-it-accepts) has the
details.

**Generate** runs a workflow by hand: a form on one side, the run history on the
other. Handy for checking a workflow does what you think before a job server
starts sending work. The history narrows by state and by where the job came
from, and flips into a gallery of everything the filtered runs produced.

A run in flight carries a bar — the steps ComfyUI has done out of the steps it
expects, and the node it is on — so a slow workflow can be told from a stuck one.
Jobs claimed from a job server land in the same history, so they get the same
bar, and the status bar carries the percentage on every page.

The header switches the theme and the language, and the button beside them opens
the app's own settings — the same switches the tray menu carries.

### What this machine will start

Beside *Start ComfyUI* is a dot with three states, picked the way a chat app
picks a presence.

| | | Jobs from a job server | Runs you start here | ComfyUI |
| --- | --- | --- | --- | --- |
| 🟢 | **Accepting** | yes | yes | left alone |
| 🟡 | **Not accepting** | no | yes | left alone |
| 🔴 | **Stopped** | no | no | shut down |

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

Both only hold jobs back. ComfyUI stays up, runs you start here still go, and
job servers still see the machine — they simply get nothing out of it until the
hold is over. The header says which of the two is holding it and the status bar
says how much is left.

A hold is stored with its end time rather than counted down in memory, so
restarting the app in the middle of one does not start claiming early.

## The tray

Closing the window does not stop anything. The app stays in the tray with:

| Menu item | What it does |
| --------- | ------------ |
| **Open** | brings the window back |
| **Generation** | the three states above, *Stopped* asking first |
| **Stop ComfyUI** | stops the ComfyUI this app started |
| **Quit** | stops the app and its server |

Two things are set from the app's settings button rather than the tray:

- **Start when the computer starts**
- **Closing the window** — keep running in the tray, or quit

Both are stored with everything else, so the tray and the page always agree.

## Pointing it at ComfyUI

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

## Bring your own workflow

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

The Workflows page shows which of these were found, so a workflow that needs help
is obvious before you run it. Anything not found is simply not offered — a
workflow with no `LoadImage` gets no image field.

*Check* on a workflow's row goes further: it asks the running ComfyUI — via
`/object_info` — whether every node type in the file exists there, and whether
every file-choosing input (checkpoints, LoRAs, VAEs, …) names something
actually installed, without running anything. Inputs the app replaces at run
time, the input image above all, are left out of the check.

Outputs are not detected in advance. Whatever ComfyUI records in its history for
the run is collected, so images, videos and gifs all work with no configuration.

### When detection gets it wrong

Put the mapping in a sidecar named after the workflow, `<workflow>.slots.json`,
beside it in the workflows folder:

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

Left alone, the app runs standalone. Add a server on the Servers page and it
also polls for queued jobs, runs them through the active workflow and uploads
the result — which is the point of the tray: the machine keeps serving with
nothing on screen.

Each row has a *Test* button. It sends one heartbeat there and then, so a wrong
secret answers `HTTP 401` immediately instead of looking like an unreachable host
until the next beat. It tests what is on screen, so a secret you have typed but
not saved is the one tried; leaving the box blank tests the stored one.

Several can be served at once. They are asked in the order the list puts them,
so the top of the list is the priority: a server with work queued keeps this
machine until it runs dry, and only then does the next one get a turn.

[super-stylish-studio](https://github.com/mintani/super-stylish-studio) is one
such server: a queue and a web studio on Cloudflare Workers, built for this. Any
server implementing the endpoints below works just as well.

The protocol is five endpoints under `/api/internal/hosts/:hostId`, all
authenticated with `Authorization: Bearer <secret>`:

| Endpoint                   | Purpose                                                      |
| -------------------------- | ------------------------------------------------------------ |
| `POST /heartbeat`          | report ComfyUI status; may reply `{ pendingJobs }`           |
| `POST /jobs/claim`         | take the next job, or `204` when there is nothing to do      |
| `POST /jobs/:id/result`    | the produced file, as the raw request body                   |
| `POST /jobs/:id/complete`  | mark done                                                    |
| `POST /jobs/:id/fail`      | mark failed, with `{ reason }`                               |

A server may also implement one endpoint outside that block:

| Endpoint                        | Purpose                                                   |
| ------------------------------- | --------------------------------------------------------- |
| `POST /api/internal/hosts/link` | trade `{ code }` for `{ hostId, hostSecret, hostName }`    |

That is what *Link* on the Servers page calls. It is unauthenticated because
the code is the credential: the server issues it, it works once, and it expires.
A server without it is used the same way as before — fill the host id and secret
in by hand.

A claimed job looks like:

```json
{
  "jobId": "…",
  "userId": "…",
  "sourceImageBase64": "…",
  "sourceImageContentType": "image/png",
  "workflow": "my-video",
  "params": { "positivePrompt": "…", "seed": 42, "seconds": 5 }
}
```

`workflow` and `params` are optional; without them the active workflow runs with
its own values and a random seed.

Because ComfyUI is a single machine, jobs are always run one at a time. Switch
to *Not accepting* and nothing more is claimed, while the job in flight
finishes.

## Without the app

The window is a window onto a plain server. That server runs on its own, which
is what you want on a headless box, or if you would rather not run a binary
someone else built:

```bash
bun install
cp .env.example .env    # optional; the defaults work locally
bun start
```

Open <http://127.0.0.1:3939>. Everything above works the same, minus the tray
and the settings that belong to it. Needs [Bun](https://bun.com) 1.3 or newer
and nothing else — there are no runtime dependencies.

### Configuration

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

The app sets `DATA_DIR`, `UI_PORT` and `UI_TOKEN` itself, so these matter only
when running from source.

## Who can reach the UI

The UI can start a process on this machine, so it is worth knowing what protects
it. Binding to `127.0.0.1` is not on its own enough: a page you happen to visit
can make *your* browser post to a local server, and a domain that resolves to
`127.0.0.1` can talk to one as same-origin.

Three checks, in `src/ui/guard.ts`, cover `/api/*`:

| Check | What it stops |
| ----- | ------------- |
| **Host** — only IP literals and `localhost` are answered | a rebound domain name reaching the API |
| **Origin / `Sec-Fetch-Site`** — a cross-site write is refused | a web page you visited driving this UI |
| **`UI_TOKEN`** — off unless set | anyone else on the network |

Requests with no `Origin` at all — `curl`, a script — are allowed through, since
they cannot be a browser being used against its owner.

The page itself is served without these; it is static markup with nothing in it,
and every request it then makes is checked.

The app always sets a fresh `UI_TOKEN` at launch and hands it to its own window
once, so nothing else on the machine can drive it. Running from source, **set
`UI_TOKEN` before changing `UI_HOSTNAME`**: generate one with
`openssl rand -hex 24`, then open the UI once as `http://host:3939/?token=…`.
The browser keeps it and clears it from the address bar. Starting with a
non-loopback hostname and no token prints a warning at boot.

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
