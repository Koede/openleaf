# openleaf — an open-source Overleaf-style LaTeX editor

Multi-file LaTeX projects, live recompiling PDF preview, error list that jumps to the offending file and line.

## Run
```bash
npm install
npm start          # bundles the frontend, then serves http://127.0.0.1:3000
```
Requires Node 18+ and a TeX distribution with `latexmk` (TeX Live / MacTeX / MiKTeX). `biber` is only needed for `biblatex` with the biber backend; plain BibTeX works out of the box. `synctex` (ships with TeX Live) enables double-click-in-PDF → source.

## Features
- Projects are plain folders in `./projects/<name>` (override with `PROJECTS_DIR`), nested folders, `\input` / `\include` / images / `.bib` all work.
- Edit → autosave (0.7 s) → recompile. A newer edit cancels an in-flight compile. `Ctrl/Cmd+Enter` or `Ctrl/Cmd+S` forces a compile; toggle **Auto** to compile manually.
- Compiles with `latexmk` (pdflatex / xelatex / lualatex), BibTeX handled automatically, shell-escape off. Long documents are allowed to run as long as they keep making progress (new pages, files or latexmk/biber steps); a compile is stopped after 2 min with no progress (`COMPILE_STALL_MS`, catches infinite loops) or at a 20 min hard limit (`COMPILE_TIMEOUT_MS`). The status bar shows the page being typeset.
- Builds in a hidden `.build/` copy so your source folders stay clean; **Clean build** wipes it.
- Choose the main document (auto-detected from `\documentclass`); ★ marks it in the tree.
- Issues panel (errors / warnings) with click-to-jump, error lines highlighted in the editor, raw log tab.
- Autocomplete for commands, environments, `\ref` labels, `\cite` keys, `\input` and `\includegraphics` paths from the whole project.
- PDF viewer (pdf.js) keeps scroll position across recompiles; zoom / fit width.
- Upload files or whole folders (button or drag-and-drop), import an Overleaf `.zip`, download PDF or source `.zip`.

## Security
Binds to `127.0.0.1` only. LaTeX can run code (e.g. `.latexmkrc`), so don't expose this to a network or untrusted users without adding auth and sandboxing (Docker / bubblewrap).

## v2 additions
- **Σ Symbols palette** (Ctrl/⌘+Shift+K): *Templates* (Mathematica-style: click derivative, vec hat, matrix… and the caret lands in a blank □ box; type, Tab to the next box; selected text is wrapped into box 1), searchable *Symbols* (588), and *Detexify* (draw a symbol, matched locally). A missing `\usepackage` is offered with one click.
- Sidebar: Files / Outline / project Search & Replace / History (diff + restore, deleted-file recovery).
- Security: host allowlist, same-origin checks, optional `AUTH_TOKEN`, symlink and zip-slip protection, no shell-escape.
- Env: `PORT`, `HOST`, `PROJECTS_DIR`, `AUTH_TOKEN`, `COMPILE_TIMEOUT_MS`, `COMPILE_STALL_MS`, `ALLOWED_HOSTS`.
- `npm test` runs the backend tests. `npm run build:demo` builds `dist/standalone.html`, a server-less page (no compiling).

## Accounts and hosting on your own domain
Set `ACCOUNTS=1` to require sign-in: every user gets a private folder (`PROJECTS_DIR/<username>/`), so their `.tex` files are saved to their account and follow them across devices. Passwords are scrypt-hashed, sessions are httpOnly cookies, logins are rate-limited, and users cannot see each other's files or live events.

| Variable | Default | |
|---|---|---|
| `ACCOUNTS` | off | `1` turns on login/registration |
| `TEX_OPENIN` | `p` | TeX read policy. `p` (paranoid, default) blocks absolute paths, hidden files and `../` that leaves the project; `../` *inside* the project (e.g. `\subimport{../other-chapter/}{x}`, common in Overleaf projects) works via a small preload library built into the image (`server/native/kpse_dotdot.c`, set `TEX_DOTDOT=0` to turn it off). `r` lifts the remaining limits — only for servers where you trust every account |
| `ALLOW_SIGNUP` | `1` | `0` = invite-only; add users with `ADD_PASSWORD=… node tools/adduser.js alice` (`--adopt` moves existing single-user projects into the account) |
| `MAX_PROJECTS` | 50 | per-user project limit |
| `SECURE_COOKIES` | off | `1` behind HTTPS (the Docker setup sets it) |

**Deploying to a domain** (e.g. one registered at Squarespace Domains): a domain only provides DNS, so you need a server with Docker (any small VPS). Then
1. In the domain's DNS settings add an `A` record (host `latex`, or `@`) pointing at the server's IP.
2. On the server: `git clone https://github.com/Koede/openleaf && cd openleaf && DOMAIN=latex.example.com docker compose up -d`. Caddy fetches an HTTPS certificate automatically.

LaTeX compilation executes code (shell-escape is off and file access is restricted, but it is not a hard sandbox). For a public server keep `ALLOW_SIGNUP=0` unless you trust your users, or add container-level isolation.

## Formatting toolbar (Google-Docs style)

The row under the editor toolbar inserts LaTeX for you. Click a control and the code is placed at the caret with a blank box
inside it, so whatever you type next comes out formatted; press **Tab** to step out of the group. With text selected the
selection is wrapped instead.

| Control | Result |
| --- | --- |
| Style (Normal / Section / Subsection …) | turns the current line into `\section{…}`, swaps or removes an existing heading |
| Font, Size, Custom size | `\textsf{…}`, `{\Large …}`, `{\fontsize{18}{21.6}\selectfont …}` |
| B I U S x² x₂ tt, colour, highlight | `\textbf`, `\underline`, `\sout`, `\textcolor{…}`, `\hl{…}` |
| Align, lists, quote, columns, spacing | `center` / `flushleft` / `flushright` / `justify`, `itemize` / `enumerate` (Enter adds the next `\item`), `quote`, `multicols`, `spacing` |
| Table grid, Insert menu | tables with a box per cell, links, images, footnotes, citations, equations, title block, page break… |

Packages a control needs (`xcolor`, `soul`, `ulem`, `ragged2e`, `setspace`, …) are offered with an **Add it** button.
Shortcuts: `Ctrl+U`, `Ctrl+Shift+E/L/R/J`, `Ctrl+Shift+7/8`, `Ctrl+Alt+0…3`.

## Overleaf-style editing

| | |
|---|---|
| **Code / Visual editor** | The switch at the left of the editor toolbar. *Visual* shows a `.tex` file as formatted text: headings, bold/italic/underline/colour, bullet and numbered lists, formulas rendered with KaTeX (the project's `\newcommand`, `\def` and `\DeclareMathOperator` definitions included), figure previews (PNG/JPG and the first page of PDF figures), `\ref` / `\cite` / `\label` / `\input` chips, the preamble folded away and `\maketitle` shown as the title. The file stays plain LaTeX: markup reappears where the cursor is (click a formula to edit its source, with a live preview underneath), `Ctrl/⌘`-click a reference to jump to its label or an `\input` chip to open that file. |
| **Recompile menu** | ▾ next to Recompile: stop the compilation, recompile from scratch, auto compile on/off, *Normal* or *Fast [draft]* mode (images drawn as boxes), stop on the first error or try to compile despite errors. |
| **Outline** | Sidebar tab plus a resizable *File outline* under the file tree; follows `\input`, `\include`, `\import` and `\subimport`. Breadcrumbs above the editor show where the cursor is. |
| **Insert reference / citation / figure** | Toolbar buttons: pick a label (with the heading or caption it belongs to; `\cref` offered when cleveref is loaded), pick one or more `.bib` entries (searchable by key, author, title, year), or upload a figure into `figures/` with caption and label. |
| **PDF** | ← → arrows on the divider jump between source and PDF (SyncTeX); ▶ presents the PDF full screen one page at a time (arrows/space to move, Esc to leave). |
| **Sharing** | *Share* (with accounts on): invite people by user name as *can edit* or *can view*, or turn on a link for either role. Shared projects appear in the project menu under *Shared with you*; viewers get a read-only editor. |
| **Real-time co-editing** | People in the same file type together (Yjs): coloured cursors with names, presence chips in the breadcrumbs, per-person undo. The server saves the shared text, so co-edited files are never "unsaved". |
| **Review** | Comment on a selection (threads, resolve, reopen), and *Track changes*: insertions and deletions are recorded per person and can be accepted or rejected one by one or all at once. |
| **Chat** | A chat per project in the sidebar, with an unread badge. |

## Feedback (bug reports and feature requests)

**Feedback** in the top bar opens a form with two kinds, *Bug* and *Feature request* (bugs start
from a what happened / expected / steps template). Optionally it attaches diagnostics, shown in full
before sending: openleaf and TeX versions, browser, engine and main file, and the last compile's
error messages. It never attaches document text or the project's name.

- **Send** stores the report on the server (`<PROJECTS_DIR>/.openleaf/feedback.json`). Each user
  sees what they sent; admins see everything, can set a status (open, planned, in progress, done,
  won't do) and delete items. Admins are the users in `ADMIN_USERS` (comma-separated) or, if unset,
  the first account created; without accounts the single user is the admin. Admins get a count of
  open reports on the button. Limits: 15 reports per user per hour, 20 000 characters per report.
- **Open on GitHub** opens a prefilled public issue (labelled `bug` or `enhancement`) on
  `FEEDBACK_GITHUB` (default `Koede/openleaf`; set it empty to hide the button). The person reviews
  it on GitHub before posting.

## Tests

`node --test test/*.test.js` runs the unit/API tests, including a benchmark for the Detexify matcher (`tools/tune-matcher.js`
re-tunes its weights). `test/e2e/format.e2e.js` and `test/e2e/visual.e2e.js` are Playwright smoke tests for the formatting
bar and the Visual Editor; each creates and deletes a project of its own on the running server.
