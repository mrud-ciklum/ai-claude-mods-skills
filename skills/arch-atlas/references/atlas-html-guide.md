# atlas.html — build guide

One self-contained file: no CDN, no fonts, no fetch. Vanilla JS, SVG for the map,
CSS custom properties for theming. Everything renders from the embedded manifest —
if you find yourself hardcoding a stage name in markup, stop and render it from
data instead.

## Skeleton

```html
<title>{Project} Atlas</title>
<style>/* tokens + layout, see Theming */</style>

<header>  project · scope · mode switcher · footer-stamp summary  </header>
<main>
  <svg id="map">        <!-- always visible; the spatial anchor -->
  <aside id="detail">   <!-- fills on node click -->
  <aside id="questions"><!-- open-questions panel, collapsible -->
</main>

<script type="application/json" id="manifest">
  { ...the verbatim atlas-manifest.json... }
</script>
<script>
  const M = JSON.parse(document.getElementById('manifest').textContent);
  // render everything from M
</script>
```

Embedding the manifest verbatim keeps one source of truth inside the artifact and
lets a Phase 4 refresh diff the shipped manifest against the repo's copy.

## The map

- Render stages as SVG groups at `stage.pos` — never auto-layout; positions are
  part of the knowledge and must survive refreshes.
- Edges as paths, colored by `particle.color`. Curved paths read better than
  straight lines when lanes converge.
- Subsystem grouping: a soft background region per `subsystem` value, so the map
  reads at two altitudes (subsystems at a glance, stages on focus).
- Stages with a **silent** sharp edge (fails without erroring) get a visual warning
  mark — that's the highest-value fact a map can carry for a newcomer.
- External black boxes: visually distinct (dashed border), clickable to show their
  `contract`.
- The map pans/zooms if it must, but prefer an altitude where it doesn't need to.

## Modes

One mode switcher in the header; modes change behavior, never geometry.

**Explore** (default). Click a node → detail panel shows: `role`, anchors (as
`path:line` code-style text), config table (key / default / effective — with
`unverified` styled as a warning, not hidden), inputs/outputs, sharp edges,
`who_breaks_if_changed`, and the stage's verification verdict.

**Trace.** Pick a particle → its journey plays hop by hop along its edges: the
moving dot, the current stage highlighted, a caption per hop. Numbers come from an
optional `traces` block (same JSON script pattern) filled with real run data via
each stage's `metrics_hook`. No trace data → the caption badge says `schematic` on
every hop. Never fabricate plausible-looking numbers — a fake "1,203 candidates"
poisons trust in the whole artifact.

**Config lens** (only when `config_lens: "full"`). Toggle defaults ⇄ effective.
Nodes where any key diverges get a strong highlight; the detail panel sorts
divergent keys first. When `config_lens: "defaults-only"`, render a persistent
badge: "showing code defaults — effective config unverified".

**Quiz.** Hide all stage labels; the user recalls each stage from position and
connections, clicks to reveal, gets a running score (recalled / peeked). Offer
"labels → roles" as a second round: show the name, recall what it does. Recall is
the certification of understanding; that's the whole reason this mode exists.

## Theming

Define the full light palette as tokens on `:root`; override tokens under
`@media (prefers-color-scheme: dark)`. Give `body` an explicit token background.
Particle colors come from the manifest — check them for contrast on both themes,
adjust lightness per theme via `color-mix` if needed.

## Footer stamp

Always present, small, honest:

```
built from abc1234 · 2026-08-17 · 34 verified · 2 partial · 3 open questions
```

If `generated_from.dirty` is true, say `abc1234+dirty`. The stamp is what lets a
future reader (or a Phase 4 refresh) judge whether to trust the map.

## Checklist before delivering

- renders with the file opened directly (no server), no console errors;
- both themes readable; no horizontal page scroll at laptop width;
- every stage clickable, every mode reachable, quiz score works;
- `unverified` config visibly marked; schematic trace visibly labeled;
- open-questions panel matches `open_questions` exactly;
- stamp matches `verification.md` totals.

Deliver as a local file. If the user wants to share it, the Artifact tool (where
available) can publish it — their call, not a default.
