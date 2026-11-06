# wed

**Point at the page, say what to change, and Claude edits the source.** `wed` puts a small overlay on top of your local website. You click an element, type what you want, and press Send. A Claude Code session running `/live-edit` receives the batch with the exact file and line of every element, applies the edits, and the page reloads itself. You never switch to the terminal to describe where something is.

## Quick start

```bash
cd path/to/your-site
wed .                      # serves the folder at http://localhost:4747 and opens it
```

Then, in Claude Code started in the same folder:

```text
/live-edit
```

In the browser:

1. Press **P** to enter pick mode, then click any element.
2. Type the change, for example "make this 20% larger and bolder", and press **⌘↵** to queue it.
3. Repeat for as many elements as you like, then press **Send** (or **⌘⇧↵**).

The green dot in the toolbar means Claude is listening. Each note's badge goes from orange (draft) to blue (applying) to green (done), with Claude's one-line summary underneath.

## Install

```bash
git clone https://github.com/Joongeun/wed.git
cd wed
npm install
ln -s "$PWD/bin/wed.js" ~/.local/bin/wed   # puts `wed` on your PATH
wed install       # installs the /live-edit command into ~/.claude/commands
```

Node 20 or newer is required. Screenshots and the inspiration board use Playwright's Chromium, and version 1.58.2 matches the build already cached on this machine. If Chromium is missing, run `npx playwright-core install chromium`. Everything else works without it.

## What it does

**Every click resolves to a file and line.** In static mode, `wed` serves each HTML file with a `data-wed-src="index.html:212:9"` attribute added to every element. The file on disk is not touched. Claude therefore edits line 212 instead of searching for "the grey subtitle under the hero". An optional test checks this against a real 893-line page: all 523 tagged elements point at the right line.

**Proxy mode covers sites that need their own server.** For example, `wed 4000` wraps a Jekyll server running on port 4000. `wed` forwards every request to that server and injects the overlay into HTML responses. There are no line numbers in this mode, so Claude locates elements by their text, classes and HTML instead.

**Claude listens through a background command, not the terminal.** `/live-edit` runs `wed wait` in the background. That command blocks until you press Send, prints the batch, and exits. Claude Code wakes Claude whenever a background command exits. Claude applies the batch, reports each item with `wed done`, and starts waiting again.

**Exact edits skip the main session and go to Sonnet.** Some edits need no judgment: retyped text that `wed` could not write directly, or slider values with no note. Spending an Opus turn on those wastes tokens. `wed` sends any batch made only of such edits to a headless `claude -p --model sonnet` run in the project folder. That run can read and edit files, but it cannot run commands. Batches containing a free-form note or an inspiration ref still go to your `/live-edit` session. In one test, Sonnet applied a text change and a radius change in 14 seconds. If the Sonnet run cannot start, the batch falls back to the main session. Use `--fast-model haiku` for a cheaper model, or `--fast-model off` to send everything to the main session.

### The six features

1. **Click, describe, send.** Hover highlighting, a note popover, a queue with numbered pins, batch Send, live reload, and a width switcher (375, 768 and 1280 px). A reload never happens while you are halfway through typing a note. It waits until you close the note.
2. **Inline text editing.** In pick mode, double-click any text, retype it, and press Enter. `wed` writes the change straight into the HTML file in under a second, with no Claude turn. Headings with inline formatting work too. Double-clicking anywhere in `<h1>Every way <mark>one place</mark></h1>` edits the whole heading and keeps the `<mark>`. Elements that hold layout blocks, such as a `<div>` with paragraphs inside, show a message asking for a note instead. If the page text does not match the file, the change is queued for Claude, so it is never lost.
3. **Undo per batch.** Before Claude touches anything, `wed` copies the project's source files into `.wed/snapshots/<batch>/`. The Revert button in the page restores them byte for byte. This works without git.
4. **Taste log.** Every edit is recorded in `~/.wed/taste.jsonl` with its outcome. The outcome is kept, reverted, or re-edited if you changed the same element again within 2 minutes. `/live-edit` reads `wed taste` at the start, and Claude writes recurring preferences into `~/.wed/taste.md`. The log is global, so what Claude learns on one site carries over to the next.
5. **Style nudge panel.** Click **Style** in the popover to get sliders for font size, weight, line height, letter spacing, padding, margin, gap, radius, max width and opacity, plus color pickers. Changes preview live. Claude receives the exact before and after values and writes them into the stylesheet rather than as inline styles.
6. **Inspiration board.** `wed ref add https://linear.app` saves a full-page screenshot and the site's design tokens: fonts, type scale, colors, spacing, radii and shadows. `wed ref open https://linear.app` opens the site in a browser where clicking an element saves its styles and a cropped image. Any note can then attach a ref from the **Inspiration…** menu, for example "make this card like `linear/pricing-card`".

## Commands

| Command | What it does |
| --- | --- |
| `wed [folder]` | Serve a static folder with the overlay (default `.`) |
| `wed <port or url>` | Proxy a running dev server |
| `wed wait` | Block until Send, then print the batch (used by Claude) |
| `wed done <id> --note ".."` | Mark an edit done; add `--failed` if it could not be done |
| `wed revert <batch>` | Restore files to before that batch |
| `wed status` | Show the queue and whether Claude is listening |
| `wed taste` | Recent edits grouped by outcome |
| `wed ref add/open/ls` | Manage the inspiration board |

Options for starting a session: `--fast-model sonnet|haiku|off` (default `sonnet`), `--port 4747`, `--root <dir>` (the project folder in proxy mode), `--no-open`, `--watch-site` (also reload on Jekyll `_site` changes), and `--reload-delay <ms>`.

## Files it writes

- `<project>/.wed/` holds the queue, snapshots and screenshots. It contains its own `.gitignore`, so it never shows up in the site's git status.
- `~/.wed/` holds the taste log, the preferences file and the inspiration refs. They are shared across projects.

## Tests

```bash
npm test
```

There are 33 tests. They cover source-line tagging (including a real site when `WED_REAL_SITE` is set), text edits and their refusals, injection through gzip and chunked proxies, the full wait, done and revert loop, re-edit detection, routing of exact edits to the fast model (with a stand-in `claude` program), and 10 browser tests in headless Chromium. The browser tests click, queue, nudge, inline-edit plain and formatted headings, check that reloads wait while you type, and run both inspiration flows.

## Proposed for later

These are ranked by how much time each would save per site.

1. **Variant compare.** A note such as "give me 3 options" would make Claude render A, B and C behind a toggle in the overlay. You pick one and the other two are deleted. This replaces the current loop of applying an option, reverting it, and asking again.
2. **Responsive sweep.** One button would screenshot the page at 375, 768 and 1440 px and flag horizontal overflow, clipped text and tap targets under 44 px. It would queue each problem as a pre-filled note. Mobile bugs are currently found by hand, one width at a time.
3. **Section reorder.** You would drag whole sections in the overlay, and Claude would move the matching source blocks. Reordering a single-file site by description is error-prone, while dragging is unambiguous.
4. **Asset drop.** You would drop an image onto an element. `wed` would save it to `assets/`, resize it, and queue "use this image here". This removes the steps of saving the file, finding the path, and naming it in the note.
5. **Voice notes.** A microphone button in the popover would dictate the instruction through the browser's speech recognition. Most notes are one sentence, and speaking is faster than typing.
6. **Deploy preview.** A button would push the current state to a Cloudflare Pages or GitHub Pages preview branch and show the URL. You could then check the site on a real phone before merging.
