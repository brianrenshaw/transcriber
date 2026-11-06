# Transcriber design system

The values live in [`tokens.json`](tokens.json); `npm run tokens` writes them to `src/renderer/tokens.css`, and
`npm test` fails if the CSS is stale, if any colour pair misses WCAG AA in either theme, or if the stylesheet uses
a variable that is not a token or a colour of its own. This file says how the components use them.

`src/renderer/design.html` shows every component below in its states, on the app's own classes: `npm run design`
opens it, and `npx electron . --snapshot=out/snapshots --design` photographs it in both themes with hover, press
and focus forced on the elements marked `data-force`. A plain `npm run snapshot` takes the app's screens and then
this page. The page is not packaged.

## The stance

The person is checking a transcript against a recording, usually under a deadline. The screen at rest has one
thing asking for attention: the place that needs a decision. Everything else is quiet.

**The accent means two things only:** the primary action (Export, the edit chip's Edit) and the current
selection (the open flag's ring, its tick on the timeline, the chosen reading, the selected transcript in the
sidebar). Play buttons, progress bars and finished steps are neutral. **Review** (amber) means "needs a
decision" and nothing else. **Changed** and **removed** mark what was put in and taken out. **Danger** is for
failures and destructive actions. Dark is designed with light: the same roles, never a dark-only swap.

## The no list

- **No colour per speaker.** Speakers are told apart by name and weight; a hue per voice would compete with the
  review marks, which are the point of the screen.
- **No confetti or "all done" celebration.** Finishing the review says so in one line and offers Export.
- **No onboarding tour.** The empty screen says what goes there and how; the keyboard hint sits under each card.
- **No badges or unread counts** in the sidebar beyond "N to review", which is the work itself.
- **No modal dialogs** except to confirm moving a transcript to the Trash.

## The cared-for moments

1. **Deciding a flag.** Pressing 1 or 2 (or clicking a reading) marks the choice at once (under 100 ms), the words
   in the transcript change in place, and the next card arrives: the old card's content fades out in the first
   30% of the transition, the new one fades in from 40%, so the rail reads as one card turning over.
2. **Hearing a spot.** R plays the flagged clip with a little lead-in; the clip's band is shaded on its own
   timeline and the playhead moves across it, so it is plain what is being heard.
3. **Opening a transcript.** The sidebar row becomes the selected row before anything loads, then the transcript
   appears; nothing slides.
4. **Dropping a file.** The veil answers the drag immediately with what will happen ("Drop to add"), and the new
   row appears at the top of the sidebar with its first step running.

## Motion

| Trigger | Elements | Duration | Curve | What it explains |
| --- | --- | --- | --- | --- |
| Press, hover | buttons, rows, chips | `t-press` 80 ms | `enter` | the control heard you |
| A decision | choice ring, word marks | `t-state` 220 ms | `enter` | this is now the reading |
| Next card | the rail card | `t-container` 320 ms, content in from 40% | `enter` | one card replaced by the next |
| A group opens | Changes group, its rows | `t-container` 320 ms, rows in from 40% | `enter` | the rows were inside the group |
| Menu, edit popover | popover | `t-state` 220 ms, scale .97 to 1 from its anchor | `enter` | it came from the button |
| Drop veil | veil | `t-state` 220 ms, opacity | `enter` | the window will take the file |
| Sheet (planned) | sheet, then its shadow | `t-context` 360 ms, shadow `t-trail` 40 ms late | `enter` in, `exit` out | a new context over this one |

Reduced motion keeps every duration and replaces movement and scale with opacity. Nothing runs longer than 500 ms.
Nothing user-initiated is `linear`, `ease` or `ease-in-out`.

## Type

| Token | Size | Face | Use |
| --- | --- | --- | --- |
| `fs-label` | 11, 700, caps, 0.06em | sans | small headings: the kind of each change in Changes, the edit popover. Never in the rail, where capitals made the card read like a form |
| `fs-note` | 12 | sans | meta lines, hints, counts |
| `fs-ui` | 13 | sans | controls and lists (the default) |
| `fs-body` | 14 | sans | ledes, group titles |
| `fs-quote` | 16 | serif | transcript words outside the reading view: choices, context, diffs, inputs that take transcript words |
| `fs-read` | 18, line 1.62, measure 66ch | serif | the transcript |
| `fs-h2` | 18, 700 | serif | screen and section headings |
| `fs-h1` | 22, 700 | serif | the transcript's title |

Serif is the transcript's voice; sans is the app's. A screen uses three sizes or fewer at once outside the rail.

## Space, radius, elevation, layout

- Space: 4, 8, 12, 16, 24, 32, 48 (`sp-1` to `sp-7`). Space belongs to the element below it. Group by proximity
  before reaching for a divider; hairlines (`border`) only where two surfaces share a value.
- Radius: `r-s` 6 (controls, marks), `r-m` 8 (cards, menus, drop zone), `r-l` 12 (the page's top corners, sheets).
- Elevation: `elev-0` resting controls and the page, `elev-1` hover, the rail card and group cards, `elev-2` menus, `elev-3` popovers over
  text. Dark uses deeper shadows on the same rungs.
- Layout: sidebar `sidebar-w` 248 (208 under 1120 px), header `toolbar-h` 52, rail `rail-w` 392 (340 under
  1240, 300 under 1080), transcript measure 66ch.

---

## Components

Every interactive component has default, hover, pressed, focus-visible (2 px `accent` ring) and disabled states
unless it says otherwise. "Gap" marks something the spec asks for that the code does not do yet.

### Window shell
- two surfaces and no lines between them: the chrome (sidebar, header, rail, player) is one `bg` grey; the page
  is the one `surface` in it, with `r-l` top corners and `elev-0`. The page is the transcript, the steps while
  transcribing, the Changes list, or the home screen. A page with no rail beside it keeps `sp-3` of chrome on its
  right. The window carries no app name; the menu bar and the Dock have it.
- the header band (`toolbar-h`) drags the window
- a11y: the sidebar is a `nav` labelled "Transcripts"; the title bar area is draggable, controls inside it are not
- used on: every screen

### Sidebar header
- the traffic lights, then at the right an icon button with a plus: Add recordings (⌘O)
- used on: sidebar

### Sidebar transcript row (`.job-row`)
- content: title (`fs-ui` 700, `text-strong`, one line, ellipsis), meta (`fs-note`, `text-muted`): "N to review ·
  duration", the running step with its percent, or the failure in `danger`
- states: default, hover (`hover`), pressed (`press`), selected (`selection` tint, `aria-current="true"`),
  focus-visible (inset ring), working, failed
- a11y: a real `button`; Up and Down move between rows (gap)
- used on: sidebar

### Setup line (`.setup-line`)
- shows only while setup is unfinished: the speech models downloading (with a `meter`), missing, failed or
  unavailable on this Mac; `danger` text when it failed, with a Retry quiet button
- tokens: `surface`, `elev-0`, `r-m`, `fs-note`; the meter fill is `text-muted`, not the accent
- a11y: `role="status"`
- used on: the foot of the sidebar

### Button (`.btn`)
- variants: **primary** (`accent`, `on-accent`, 700; one per screen), **secondary** (default: `surface`, `elev-0`,
  `text-strong`), **quiet** (no fill until hovered, for actions that sit in text or lists)
- size: one, 28 px tall (6 px padding, `fs-ui`); `r-s`
- states: hover (secondary rises to `elev-1`; primary to `accent-hover`; quiet takes `hover`), pressed
  (1 px down, back to `elev-0`), focus-visible ring 2 px offset, disabled (45% opacity, no shadow)
- label: the verb of the action ("Export…", "Choose files…", "Retry"), never OK or Submit
- keyboard hint: a `kbd` after the label in `fs-label`, `text-muted`, `border` outline, outside the rail only (Choose
  files, the edit chips and popover). In the rail the help line under the card names every key once, and each
  button keeps its key in its tooltip ("Type it (E)")
- used on: header (Export), empty screen, rail, Changes groups, notices

### Icon button (`.icon-btn`)
- 30 px square (26 px `nav` variant for the card pager), 18 px stroke icon at 1.5, `text-muted` until hovered
- a11y: always an `aria-label` ("More", "Previous", "Next")
- used on: sidebar header (+), header (···), rail card pager

### Segmented control (`.seg`)
- two to three options in a `hover`-tinted track, so it reads on the chrome and on the page; the selected one is `surface`, `elev-0`, 700, `text-strong`; counts in
  `fs-note` `text-muted` (`text` when selected)
- a11y: buttons with `aria-pressed`; the group has an `aria-label` ("View", "Show")
- used on: header (Transcript / Changes), Changes (To review / All)

### Menu (`.menu`)
- a popover under its button: `surface`, `elev-2`, `r-m`, 220 px min; rows are quiet buttons with `selection` on
  hover; a row that cannot run now is `text-faint` with no hover; an `hr` separates the destructive item (Move to Trash) from the rest
- motion: pops from its anchor corner (scale .97 to 1, `t-state`)
- a11y gap: the trigger needs `aria-haspopup` and `aria-expanded`, the list `role="menu"` with arrow-key movement,
  and Escape should close it and return focus to the trigger
- used on: header ···

### Notice (`.notice`)
- a line under the header: what happened in `danger` 700, what to do next in `text`, a Dismiss quiet button;
  `danger-soft` fill
- a11y: `role="status"`
- copy: states what happened and what to do, in that order; no apology, no exclamation mark
- used on: empty screen (files that are not audio), transcript screen (export or step failures)

### Text input (`.link-input`, `.speaker-input`, `.own input`, `.manual-input`)
- `surface` fill, 1 px `border-input` (3:1 against what it sits on), `r-s`; focus swaps the border for a 2 px
  `accent` outline
- inputs that take transcript words use `fs-quote` serif; the rest `fs-ui` or `fs-note` sans
- a11y: every input has a visible label or an `aria-label`; Enter saves, Escape cancels
- used on: empty screen (who's speaking), speaker names, the rail's Type it, the edit popover

### Drop zone and drop veil (`.drop-zone.big`, `.drop-veil`)
- drop zone: on the home screen's page; dashed 1.5 px `border`, `surface`, `r-m`; title `fs-h2` sans 600, hint `fs-note`, one primary button
  with its ⌘O hint; the copy says what goes here and how to put it there
- veil: the whole window takes a `veil` tint and a raised label (`elev-3`) the moment a drag enters; it fades
  with `t-state`
- states: rest, dragging over the window, dropped files that are not audio (a notice names them)
- used on: empty screen; the veil on every screen

### Transcript header (`.job-head`)
- title `fs-h1` serif, one line; meta `fs-note` `text-muted`: when added, duration, "N of M to review"; a Whisper
  failure adds "Whisper didn't run" in `review-text`
- actions, right: the view segmented control, ···, the primary Export
- used on: transcript screen

### Steps (`.steps`)
- the transcript screen before the review is ready: one row per step with a dot, the step, and its time
- dots: pending `border`, running `accent` (breathing, stopped under reduced motion), done `text-muted`, failed
  `danger` with the error under it in `fs-note`
- used on: transcript screen while transcribing

### Reading view (`.doc`)
- paragraphs in `fs-read` serif, measure 66ch; speaker labels `fs-ui` 700 sans with a colon (unnamed voices in
  `text-muted`); headings `fs-h2`
- word states, on the words themselves:
  - **needs a decision**: `mark` fill, `mark-strong` on hover
  - **the open flag**: plus a 2 px `accent` ring
  - **changed**: an underline in `changed` (55%), no fill
  - **removed**: a 3 px `changed` bar where the words were
  - **undecided suggestion** (AI pass, planned): dotted `review` underline; the heard words struck in `removed`,
    the suggestion after them
  - **now playing**: `now` tint
  - **selected for an edit**: `changed` at 25% as the text selection
- hover on any word: `hover`, click plays from it
- used on: transcript screen

### Edit chips and edit popover (`.edit-chips`, `.edit-pop`)
- selecting words shows chips above the selection: Edit (primary, E) and New paragraph or Join paragraphs (quiet,
  P), each with its key
- Edit opens the popover in place: a `label` with the time and a quiet ▶ Play, a `manual-input` with the words,
  then Save (⏎) and Cancel (esc); Enter saves, Escape cancels
- motion: pop from the selection, `t-state`
- a11y: the popover is `role="dialog"` labelled "Edit the transcript"; focus goes to the input
- used on: reading view

### Review rail (`.rail`)
- on the chrome; from the top: progress ("N of M left to review" in `fs-note`, a 3 px bar filled
  `text-muted`), the card, then the help line in `fs-note` `text-muted` that names the card's keys
- the region is `aria-live="polite"` so a screen reader hears each new card
- used on: transcript screen

### Review card (`.card`)
- one `surface` card, `r-m`, `elev-1`, `sp-4` padding; everything inside it sits on that white or on
  `surface-sunken`, with no shadows of its own
- header: the kind and time in sentence case, `fs-ui` 700 `text-strong` ("Engines disagree · 1:43"), pager
  "N of M" with previous and next icon buttons that never wrap
- clip: a neutral play button (`neutral-fill`), a 28 px track on `surface-sunken` with the spot's band in
  `mark-strong` and a 2 px playhead, the speed
- context: the sentence around the spot in `fs-quote` serif, the spot in `mark`
- choices: one `surface-sunken` row per reading (`.choice`): the engine in `fs-note` 600 `text-muted`, sentence
  case, then the words in `fs-quote` serif; no key chip (the tooltip says "Whisper (2)"); hover and press lay
  `hover` and `press` over the row; the chosen one turns `surface` with a 2 px `accent` ring; an AI suggestion
  (planned) adds a 3 px `review` bar at the left and a `pick-tag` in `fs-note` 600 `review-text`
- Type it: a quiet button; opens an input in place
- why block (AI pass, planned): the word list's rule, the AI's reason with its confidence, and evidence rows a
  listener can play, on `surface-sunken`
- states: undecided, decided (the ring stays on the choice), typed (a "Typed" row is chosen), nothing left
  ("Everything is reviewed. Export saves the finished transcript.")
- keyboard, named in the help line: 1 to N choose, Enter uses a suggestion, E types, U undoes, R replays, S
  slows, J and K move; a speaker check takes Enter and X; the other cards Enter, X and U. The keys are reset
  with every card, so a number never reaches the card before
- used on: review rail

### Player bar (`.player`)
- on the chrome, under the page; play (`neutral-fill`), time in tabular figures, the track, speed
- track: a 2 px `border` line, the played part in `text-muted`, a tick per flag: `tick` while undecided,
  `text-faint` once decided, `accent` and taller for the open one; a 2 px `text-strong` playhead
- a11y: the track is `role="slider"` labelled "Position"; Space plays and pauses
- used on: transcript screen

### Changes group (`.group`)
- one card per kind of change (`surface`, `elev-1`, `r-m`), closed until opened: a chevron that turns 90°,
  the title `fs-body` 700, the count, a status or action on the right ("Listen to decide", Accept all), and a
  one-line hint
- opening: the rows fade in from 40% of `t-container` under a `border` hairline
- rows (`.change`): time, the diff in `fs-quote` serif (context `text-muted`, `removed` struck, `changed` put in,
  dotted `review` while undecided), the reason in `fs-note`, per-row actions; hover `hover`; click opens it in the
  transcript
- a11y: the toggle is a button with `aria-expanded`
- used on: Changes tab

---

## Planned components

Specified now so they arrive on the same tokens. None is built yet.

### Library list with search
- a search field at the top of the sidebar (`fs-ui`, `border-input`, a magnifier, Escape clears); results grouped
  under date headers (`label`), each a transcript row with a two-line preview of the matching words in
  `fs-note`, the match in `mark`
- empty states: "No transcripts yet. Drop a recording on the window." and "Nothing matches “…”."

### Settings
- a window of grouped rows: group headers in `label`, rows on `surface` inside `r-m` groups, a title in `fs-ui`, a
  one-line description in `fs-note` `text-muted`, the control at the right (switch, popup, button)
- switch: 26 × 16 track, `border-input` off, `accent` on (it is the current selection), 120 ms thumb

### Export sheet
- a sheet over the transcript (`r-l`, `elev-3`, `t-context`): live preview on the left in the export's own face,
  format choices on the right as a segmented grid (Text, Markdown, SRT, VTT, DOCX), options as settings rows,
  the actions at the bottom: Copy (secondary) and Export… (primary)

### Model row
- the engine's name, size and what it is for; Download (secondary) with a `meter` while it runs, then a
  `text-muted` "Ready"; failures in `danger` with Retry

### Word list table
- rows of "write it as" and "heard as" in `fs-quote` serif, an "every time" switch, a note; Add (secondary); the
  empty state says what the list does in one sentence
