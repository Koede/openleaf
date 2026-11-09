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
| `TEX_OPENIN` | `p` | TeX read policy: `p` (paranoid) rejects `..` and paths outside the project; `r` allows `\input{../x}` but lets a document read any non-dot file the server user can — only for servers where you trust every account |
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

## Tests

`node --test test/*.test.js` runs the unit/API tests, including a benchmark for the Detexify matcher (`tools/tune-matcher.js`
re-tunes its weights). `test/e2e/format.e2e.js` is a Playwright smoke test for the formatting bar.
