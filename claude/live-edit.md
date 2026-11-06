---
description: Live-edit loop. Apply edits the user makes by clicking elements in the wed browser overlay.
argument-hint: "[site folder or dev-server port]"
---

You are in a live-edit loop with the `wed` overlay. The user is looking at the page, not at this terminal. They click elements, describe changes, and press Send. You apply each batch, mark it done, and go back to listening. Keep terminal output short: the overlay is where they read results.

## Start

1. Run `wed status`. If no server is running, start one in the background with `run_in_background: true`. Use `wed $ARGUMENTS` when an argument was given, otherwise `wed .`. A number such as `4000` proxies that dev server.
2. Run `wed taste` and read `~/.wed/taste.md` if it exists. These hold this user's reverted, re-edited and kept edits across all their sites. Follow the preferences they show.
3. Run `wed wait` with `run_in_background: true`. It exits when the user presses Send, and you are woken with its output.
4. Tell the user, in one line, that you are listening and the page URL.

## Each batch

When `wed wait` exits, its output lists every edit. For each item:

1. **Locate.** `source: index.html:212:9` is the exact start tag of the clicked element in that file. Read around that line and edit there. Without a source line (proxy mode), search for the quoted text or the classes in `outerHTML`.
2. **Look when it is visual.** If the instruction is about appearance or is ambiguous, Read the `screenshot:` PNG. It shows the element outlined in red at the user's viewport.
3. **Apply the smallest change that does what was asked.** Do not refactor, rename or reformat nearby code.
   - **Style changes** list exact before and after values the user previewed with sliders. Write them into the stylesheet rule that styles this element. Add a class-scoped rule if none fits. Never leave them as inline `style` attributes.
   - **Viewport** `phone` or `tablet` means the user was looking at that width. Put layout fixes inside a matching media query unless the note says the change is global.
   - **Text changes** replace the words exactly as given.
   - **Inspiration refs** point to files. Read `tokens.md` for a whole-page ref, or the element `.json` and `.png` for an element ref. Borrow the system: scale ratios, spacing rhythm, radii, shadows, contrast. Do not copy logos, brand colors wholesale, or text.
4. **Never ask questions in the terminal.** The user is not watching it. Make the best interpretation and state it in the note.
5. **Report through wed.** Run `wed done <id> --note "<what you changed, under 15 words>"`. If you could not do it, run `wed done <id> --failed --note "<reason>"`. The note appears in the page's queue panel.

After the batch:

1. If `wed taste` shows two or more reverted or re-edited edits with the same cause, add one line to `~/.wed/taste.md`. Write the preference and its evidence, for example: `- Prefers tight letter-spacing on headings; reverted two edits that widened it (2026-11-05).`
2. Print one line per item in the terminal, for example `✓ hero h1: font-size 48px → 58px in styles.css`.
3. Start the next `wed wait` with `run_in_background: true` straight away.

## Stop

Stop the loop when the user says stop, or when `wed wait` reports no server for more than one attempt. Leave the server running unless asked to stop it.
