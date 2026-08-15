# desktop-comfyui-server

Download Setup from releases
セットアップファイルをreleasesからダウンロードして使用してください。
このアプリは開発中のためご使用は自己責任でお願いします。

# Screenshot
<img width="1007" height="791" alt="image" src="https://github.com/user-attachments/assets/e23c64e4-981c-4d70-9e1d-3b5479b12ca5" />
<img width="1006" height="792" alt="image" src="https://github.com/user-attachments/assets/e6cacfad-ed85-4287-b417-c8192ba59cb0" />
upstream server setting
<img width="774" height="374" alt="image" src="https://github.com/user-attachments/assets/cac74acb-4b12-4d5c-82c5-c5881a9bf2a8" />


Run your own ComfyUI workflows from a browser, and optionally let a remote job
server hand work to the machine holding the GPU.

No workflow is bundled and no node id is hardcoded. You export a workflow from
ComfyUI, drop the file into `workflows/`, and the server reads the graph back to
work out where the prompts, seed and input image live.

- **Management UI** on `:3939` — upload workflows, point it at your ComfyUI
  checkout and start or stop it, order the job servers it answers to, and read
  the run history
- **Bring your own workflow** — parameters are detected from the graph, with a
  sidecar file for the cases detection gets wrong
- **Standalone or attached** — useful on its own; connect it to one or more job
  servers when you want to serve requests from elsewhere
- **Zero runtime dependencies** — just Bun

## Requirements

- [Bun](https://bun.com) 1.3 or newer
- A running ComfyUI

## Quick start

```bash
bun install
cp .env.example .env    # optional; the defaults work locally
bun start
```

Open <http://127.0.0.1:3939>.

The UI will say there are no workflows yet. In ComfyUI, turn on
**Settings → Lite Graph → Enable Dev mode options**, then use
**Workflow → Export (API)**. Upload the JSON on the **Settings** page — or drop
it straight into `workflows/` and press *Reload from disk*. Either way it
appears with the parameters detected for it.

## The management pages

Two, because most of the time this process is left running and only visited to
change something.

**Settings** is where it opens.

- *Upload* / *Installed* — add a workflow, see what each one exposes, choose the
  one used for jobs that do not name one, delete the ones you are done with
- *ComfyUI* — the directory it is checked out in, and optionally the command to
  run there. Leave the command blank and the virtualenv beside `main.py` is
  used if there is one
- *Process* — start and stop ComfyUI, with the tail of its output so a wrong
  command explains itself
- *Upstream servers* — add, reorder and disable job servers. The order is the
  priority

**Generate** runs a workflow by hand: a form on one side, the run history on the
other. Handy for checking a workflow does what you think before a job server
starts sending work.

Settings are stored in `.state.json` and the history in `.jobs.json`, both
beside the source and both gitignored.

The header switches the theme and the language. English and Japanese are both
there; English is what it opens in, and either choice is remembered in the
browser. Messages that come back from ComfyUI or from a job server are shown in
whatever words they arrived in.

## How a workflow is wired up

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

The UI shows which of these were found, so a workflow that needs help is obvious
before you run it. Anything not found is simply not offered — a workflow with no
`LoadImage` gets no image field.

Outputs are not detected in advance. Whatever ComfyUI records in its history for
the run is collected, so images, videos and gifs all work with no configuration.

### When detection gets it wrong

Put the mapping in a sidecar named after the workflow, `<workflow>.slots.json`:

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

Left alone, the process runs standalone. Add a server on the **Settings** page —
or seed one with the `SERVER_n_*` variables — and it also polls for queued jobs,
runs them through the active workflow and uploads the result.

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

Because ComfyUI is a single machine, jobs are always run one at a time.

## Configuration

Every variable is optional. See [`.env.example`](.env.example) for the full list
with comments; the ones you are most likely to touch:

| Variable      | Default                 | Meaning                                    |
| ------------- | ----------------------- | ------------------------------------------ |
| `COMFY_URL`   | `http://localhost:8188` | ComfyUI on this machine                    |
| `COMFY_DIR`   | unset                   | where ComfyUI is checked out, so it can be started |
| `UI_PORT`     | `3939`                  | management UI port                         |
| `UI_HOSTNAME` | `127.0.0.1`             | set to `0.0.0.0` to reach it from the LAN  |
| `UI_TOKEN`    | unset                   | shared secret for the UI                   |
| `WORKFLOW`    | first file found        | workflow used at startup                   |
| `UI_ENABLED`  | `true`                  | set `false` to run headless                |
| `DATA_DIR`    | this directory          | where workflows and state are written      |

`COMFY_DIR` and the `SERVER_n_*` blocks only seed the settings file. Once you
save either from the UI the stored value takes over and the variable is ignored.

## Who can reach the UI

The management UI can start a process on this machine, so it is worth knowing
what protects it. Binding to `127.0.0.1` is not on its own enough: a page you
happen to visit can make *your* browser post to a local server, and a domain
that resolves to `127.0.0.1` can talk to one as same-origin.

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

**Set `UI_TOKEN` before changing `UI_HOSTNAME`.** Generate one with
`openssl rand -hex 24`, then open the UI once as `http://host:3939/?token=…`.
The browser keeps it and clears it from the address bar. Starting with a
non-loopback hostname and no token prints a warning at boot.

## Desktop app (experimental)

`src-tauri/` wraps the whole thing in a Tauri window. There is no second
implementation: the app starts the same server, on a port it picks at launch,
and opens a window onto the same management UI.

```bash
bun install
bun run app:dev       # build the server, then open the window
bun run app:build     # installers in src-tauri/target/release/bundle
```

Needs [Rust](https://rustup.rs) and Tauri's
[platform prerequisites](https://v2.tauri.app/start/prerequisites/) —
`webkit2gtk-4.1` and `librsvg` on Linux, WebView2 on Windows.

Three things the app decides for you:

- a **data directory** — `~/.local/share/<identifier>` and the platform
  equivalents. The bundled server is a single file, so it has no directory of
  its own to write to.
- a **free port**, so the app never collides with a `bun run start` you already
  have running
- a **fresh `UI_TOKEN` each launch**, handed to the window once in the address
  and cleared from the bar. Nothing else on the machine can drive it.

The server is bundled by `bun build --compile`, which carries the Bun runtime,
so expect roughly 100 MB. Quitting kills the server outright, so a ComfyUI
started from the Process panel keeps running — stop it there first.

### On Windows

Installers are built by [`.github/workflows/release.yml`](.github/workflows/release.yml).
Push a tag and they appear on a draft release:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

To try a build without announcing one, run the workflow by hand from the Actions
tab; the installers come back as workflow artifacts instead.

Download `ComfyUI-Server_<version>_x64-setup.exe` and run it. It installs for
the current user, so there is no admin prompt, and it fetches WebView2 if the
machine does not already have it. **The installer is not code signed**, so
Windows shows *"Windows protected your PC"* — choose **More info → Run anyway**.
Signing it means buying a certificate; until then that warning is expected.

Settings, job history and uploaded workflows go to
`%APPDATA%\dev.mintani.desktop-comfyui-server`.

To build it on your own Windows machine instead:

1. [Rust](https://rustup.rs) — pick the MSVC toolchain
2. Visual Studio Build Tools with the *Desktop development with C++* workload
3. [Bun](https://bun.sh)
4. `bun install && bun run app:build`

On the Settings page, point *Directory* at whichever you have:

| What you installed | What to enter | What gets run |
| ------------------ | ------------- | ------------- |
| ComfyUI portable | the folder holding `python_embeded` | `python_embeded\python.exe -s ComfyUI\main.py` |
| A git clone with a venv | the folder holding `main.py` | `.venv\Scripts\python.exe main.py` |

Anything else goes in *Start command*. Quote a path that has a space in it.

## Development

```bash
bun run dev           # reload on change
bun run check         # oxlint + oxfmt
bun run check-types   # tsc --noEmit
```

To add a language, put it in `LANGS` at the top of `src/ui/i18n.ts` and run
`bun run check-types`. Every string that still needs translating is reported
with its line, and the header switch picks the new one up on its own.

## License

MIT
