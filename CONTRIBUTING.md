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

## Checks

`lefthook` runs oxlint and oxfmt over staged files on commit. CI repeats them
along with `tsc --noEmit`, and compiles the Rust shell with clippy.

## Releasing

A release is the version in `package.json`. Bump it together with
`src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` — the release workflow
stops if the three disagree, since the installer filenames come from Tauri's
copy — and merge that into `main`.

GitHub Actions then builds the Windows installers and opens a **draft** release
tagged `v<version>`; publish it when you are ready. Nothing is released by
pushing a tag by hand any more.

To try a build without announcing one, run the Release workflow from the Actions
tab. It builds the same installers and leaves them as workflow artifacts.
