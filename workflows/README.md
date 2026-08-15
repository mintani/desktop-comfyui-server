# PUT YOUR WORKFLOW (API) HERE

Drop ComfyUI **API-format** workflow JSON files into this directory. They are
picked up automatically — no restart needed, the management UI has a *Reload*
button.

```
workflows/
  my-video.json          <- your workflow
  my-video.slots.json    <- optional overrides (see below)
```

## Exporting an API-format workflow

In ComfyUI, the normal *Save* button writes the **editor** format, which this
server cannot run. You need the API format:

1. Enable **Settings → Lite Graph → Enable Dev mode options**.
2. Build your workflow in the ComfyUI canvas.
3. **Workflow → Export (API)**.
4. Save the resulting `.json` into this directory.

The two formats are easy to tell apart. API format is a flat map of node id to
node, and every node has a `class_type`:

```json
{
  "3": {
    "class_type": "KSampler",
    "inputs": { "seed": 42, "positive": ["6", 0], "negative": ["7", 0] }
  }
}
```

The editor format has top-level `"nodes"` and `"links"` arrays instead. If you
save the wrong one, the UI marks the file as invalid and tells you so.

## How parameters are wired up

Nothing is hardcoded to a particular workflow. On load, each file is inspected
and the interesting inputs are detected from the graph itself:

| Parameter    | How it is found                                                            |
| ------------ | -------------------------------------------------------------------------- |
| `image`      | the first `LoadImage`-style node                                           |
| `positive`   | follow a sampler's `positive` link back to the node holding the text       |
| `negative`   | same, via the `negative` link                                              |
| `seed`       | every node with a `seed` / `noise_seed` input (all are set together)       |
| `length`     | a node with a numeric `length` input (frame count on video workflows)      |
| `frameRate`  | a node with a numeric `frame_rate` input                                    |

Outputs are not detected in advance — whatever ComfyUI reports in its history
for the run is collected, so images, videos and gifs all work.

## Overriding the detection

Detection is best-effort. When a workflow is unusual — several `LoadImage`
nodes, prompts reached through custom conditioning nodes — put the mapping in a
sidecar file named after the workflow, `<workflow>.slots.json`:

```json
{
  "image": { "nodeId": "97", "input": "image" },
  "positive": { "nodeId": "129:93", "input": "text" },
  "negative": { "nodeId": "129:89", "input": "text" },
  "seed": [{ "nodeId": "129:86", "input": "noise_seed" }]
}
```

Only the keys you list are overridden; the rest stay auto-detected. Set a key to
`null` to disable that parameter entirely. The management UI shows the resolved
mapping for every workflow, so you can check the result without a test run.

---

Both this file and `.gitkeep` are tracked; everything else here is git-ignored,
so your own workflows stay out of version control.
