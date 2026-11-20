---
name: arch-atlas
description: >
  Build a grounded, interactive "atlas" of an entire project's architecture — the full
  path from input to output — as a verified, code-anchored knowledge base plus a
  single-file HTML map with trace, config-divergence and self-test modes. Use whenever
  the user wants to understand, teach, or document a whole system end-to-end: "map the
  architecture", "побудуй атлас проєкту", "покажи весь цикл від input до output",
  "how does this whole pipeline work", "make an onboarding map of the repo",
  "architecture overview", "візуалізуй архітектуру" — even when they don't say the
  word "atlas". Also use to refresh or re-verify an existing atlas after the code
  changed ("update the atlas", "is the atlas still accurate?"). Not for root-causing
  a single bug, reviewing a diff, or brainstorming a product idea — those have their
  own skills.
---

# Architecture Atlas

Turn a codebase into something a human can hold in their head: a verified knowledge
base of the full input→output cycle, rendered as one interactive spatial map.

## What you produce

Three artifacts, in this order — each phase gates the next:

1. **`atlas-manifest.json`** — machine-readable single source of truth: stages, edges,
   particles, anchors, config, open questions. Both the docs and the HTML render from
   it; nothing architectural lives only in prose or only in HTML.
2. **`verification.md`** — the accuracy-gate report: every claim's verdict, counts,
   and the surviving open questions.
3. **`atlas.html`** — one self-contained interactive file: the map, a trace mode,
   a config lens, a self-test mode.

Core principle: **the code is the source of truth — not the READMEs, not your
memory.** Every claim in the manifest carries a `file:line` anchor. A claim you could
not verify is an *open question*, rendered visibly in the atlas — never a silently
included "fact". A beautiful-but-wrong atlas is worse than none: it looks most
authoritative exactly where it misleads.

## Why this shape

The method adapts a "learn with LLMs" loop (build a knowledge base → verify it →
turn it into an interactive simulation → publish). Two changes for codebases:

- **Verification becomes grounding.** For an external topic the risk is
  hallucination and the check is "review yourself". Here the ground truth is in the
  repo, so every claim is pinned to code and re-checked against it.
- **The simulation becomes a spatial map with a live trace.** Spatial anchoring is
  what makes the system stick ("fusion is the funnel in the middle of the map"), and
  driving the trace with real run data turns a learning artifact into an
  observability tool you keep using after you've learned the system.

## Phase 0 — Scope the map (do not skip)

A wrong scope wastes the entire deep read, so pin it down before reading deeply.

1. Identify the project's **shape**: pipeline, service, CLI, library, app, or a
   monorepo containing several. The shape decides what "input → output" means.
2. Identify the **particles** — the units of flow whose journey the atlas tells.
   A request, a document, an event, a build artifact. One journey per particle;
   1–3 particles total. More than that means the scope is too wide.
3. Identify entry points, exit points, and the **boundary**: external systems the
   map shows as black boxes with a documented contract (a sibling repo, a SaaS, a
   DB owned by another team). Deciding what NOT to map is part of the deliverable.
4. For big systems, default to the **smallest useful slice**: one subsystem mapped
   end-to-end beats the whole system mapped at the wrong altitude. Offer the full
   map as a later expansion once the slice proves useful.
5. Confirm with the user in one round (AskUserQuestion where available):
   - scope: the slice vs the whole system;
   - output directory: committed docs (e.g. `docs/architecture/atlas/`) vs a local
     untracked folder — their repo, their call;
   - whether an **effective-config layer** exists that can differ from code defaults
     (hosting env vars, App Settings, k8s, CI secrets), and whether you can read it.
     This decides if the atlas gets a config lens or an honest "defaults only" badge.

## Phase 1 — Grounded knowledge base

Read the code the way the runtime does: entry points first, then follow each
particle hop by hop until it exits. READMEs and docs are input and hypothesis,
never authority — when a doc and the code disagree, the code wins and the
disagreement itself is worth recording as a sharp edge.

Read `references/manifest-schema.md` before writing the manifest. Rules that make
the manifest trustworthy:

- **Anchor discipline.** Each anchor is `path` + `line` + the specific claim that
  line supports. One anchor per claim, not one anchor per stage. If you can't point
  at the line, you don't know it yet.
- **Config three-value rule.** For each config key: the key, the code default, and
  the effective value with its source. If you cannot read the effective value, write
  `"effective": "unverified"` — never guess. Divergence between default and
  effective is precisely what the config lens exists to show.
- **`metrics_hook`** — where real numbers for the trace mode can come from: a
  diagnostics dict, a structured log line, a counter. `"none"` is a valid, honest
  value; it just means that stage traces schematically.
- **Sharp edges and blast radius.** Per stage: known failure modes (especially
  *silent* ones — a stage that no-ops on error is a trap worth a red border), and
  `who_breaks_if_changed` — the coupling a newcomer can't see from the file itself.
- **Altitude check.** More than ~12 top-level nodes means the altitude is wrong:
  group into subsystems and put detail one click down. The map must be readable at
  a glance; depth lives in the detail panel.
- **Stable geometry.** Assign each node an `x,y` in the manifest. Positions are part
  of the knowledge — spatial memory is the point — so refreshes must not reshuffle
  the map.

## Phase 2 — Accuracy gate

A separate pass with an adversarial stance: try to *refute* each claim, don't
confirm it. Do this with fresh eyes — re-open every anchor and check that the code
at that location actually supports the claim as written.

Verdicts per claim: `verified` / `partial` (true but imprecise — fix the wording) /
`refuted` (fix or delete) / `unverifiable` (needs prod access, another repo, a
human — becomes an open question).

Hard rule: the atlas never renders a claim that failed the gate. `refuted` claims
die, `unverifiable` claims move to `open_questions` and render in the atlas's
open-questions panel. Write `verification.md` with per-claim verdicts and the
totals — those totals go into the atlas's footer stamp, so the artifact carries its
own confidence level.

## Phase 3 — Render the atlas

Read `references/atlas-html-guide.md` first, then build. The requirements in short:

- One self-contained HTML file — no CDN, no external requests; vanilla JS + SVG.
- The manifest is embedded as a JSON block and the page renders *from it* — the
  manifest stays the single source of truth even inside the artifact.
- Always-visible overview map (the spatial anchor) + a detail panel on click.
- **Trace mode**: animate a particle along its journey. With real run data (from
  `metrics_hook`s) show real numbers per hop; without it, label the trace
  `schematic` — visibly. Never invent plausible numbers.
- **Config lens**: toggle code-defaults ⇄ effective; nodes where they diverge get
  highlighted. If Phase 0 said "defaults only", show that badge instead of the lens.
- **Self-test mode**: hide stage labels, let the user recall them from position and
  connections, reveal on click, keep score. This is the Feynman step — recall, not
  re-reading, is what certifies understanding.
- **Open-questions panel** and a footer stamp: git SHA, date, claim counts from the
  gate ("34 verified · 2 partial · 3 open questions").

## Phase 4 — Refresh (fighting rot)

An atlas that outlives its accuracy becomes disinformation with good typography.
When invoked on a project that already has an atlas:

1. Read the stamp SHA; diff the code since then (`git diff --stat <sha>..HEAD`
   scoped to mapped paths) to find which stages are touched.
2. Re-resolve every anchor: does the file still exist, does the line still support
   the claim? Moved code is drift, not failure — update the anchor.
3. Re-run the Phase 2 gate on touched stages only; update manifest + HTML; keep
   node geometry stable.
4. Report the drift explicitly: what changed, what was stale, what's newly open.

If the project has CI and the user wants durability, offer (don't impose) a check
that fails when mapped paths change but the manifest doesn't — the tripwire pattern.

## Output layout

```
<chosen-dir>/
├── atlas-manifest.json
├── atlas.html
└── verification.md
```

## Quality bar

- A stage without an anchor is not done.
- "Probably", "likely", "should" inside a manifest claim → it's an open question;
  move it there.
- The atlas is honest about what it doesn't know: open questions visible, schematic
  traces labeled, unverified config marked.
- If the map needs a legend to be understood, simplify the map instead.
- Chat in the user's language; write the artifacts in the language of the repo's
  docs unless the user asks otherwise.
