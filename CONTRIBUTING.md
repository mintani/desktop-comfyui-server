# Contributing

Work starts from an issue. Issue, commit and pull request titles are written in
English.

## Branches

`main` holds what has been released. Everything else happens on `dev`.

1. Open an issue describing the change.
2. Branch off `dev`, named `<type>/<issue>-<short-name>` — `feat/12-tray-menu`,
   `fix/13-stop-dialog`, `chore/14-release-flow`, `docs/15-readme`.
3. Open a pull request into `dev` and name the issue in it — `Closes #12`.
4. When `dev` is ready to ship, merge it into `main`. That is a release.

## Titles

Issues, commits and pull requests are all titled with
[Conventional Commits](https://www.conventionalcommits.org), with a scope where
one helps: `feat(tray): keep running after the window closes`. One line, and
within 72 characters — GitHub cuts off longer subjects.

An issue is titled for the change it asks for, a commit for the change it makes,
and a pull request for what its branch does as a whole. Those three often read
the same, which is the point: an issue and the work that answers it are easy to
line up. Reasoning goes in the body, never in the title.

Titles are English. A body can be in whichever language the discussion is in —
Japanese is common here — since it is read by whoever is looking at that issue
rather than by everyone scanning a list.

## Checks

`lefthook` runs oxlint and oxfmt over staged files on commit. CI repeats them
along with `tsc --noEmit`, and compiles the Rust shell with clippy.

## Releasing

### Versions

Versions are `MAJOR.MINOR.PATCH`. While the app is pre-1.0, a release with new
features bumps MINOR (`0.1.2 → 0.2.0`) and a fix-only release bumps PATCH
(`0.2.0 → 0.2.1`). **`1.0.0` is reserved for the first release that ships
premium features** — nothing before that milestone bumps MAJOR, however large.

### Cutting a release

A release is the version in `package.json`. Run

```
bun run bump 0.2.0
```

to write the new version into `package.json`, `src-tauri/tauri.conf.json` and
`src-tauri/Cargo.toml` in one go — the release workflow stops if the three
disagree, since the installer filenames come from Tauri's copy. Commit that on
`dev` (`chore(release): 0.2.0`), then merge `dev` into `main`.

GitHub Actions then builds the Windows installers, signs the updater artifacts
and opens a **draft** release tagged `v<version>`, with the `latest.json` that
installed apps poll. Publishing the draft is the switch: from that moment every
installed app offers the update — at launch, daily, and from **Check for
updates** in the tray — and restarts into the new version. Nothing is released
by pushing a tag by hand any more.

To try a build without announcing one, run the Release workflow from the Actions
tab. It builds the same installers and leaves them as workflow artifacts.

### The updater key

Updates are verified against a minisign key pair: the public key sits in
`tauri.conf.json`, the private key and its password live in the
`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` Actions
secrets. **Losing the private key strands every installed app** — they will
refuse anything signed with a replacement, and only a hand-downloaded installer
gets them back. Keep a copy of the key and its password somewhere safe outside
this repository, and never commit them.
