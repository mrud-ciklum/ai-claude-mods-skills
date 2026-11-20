# atlas-manifest.json — schema and example

The manifest is the single source of truth for the whole atlas. The markdown notes
and the HTML both render from it; if a fact is not in the manifest, it does not
exist for the atlas. Keep it hand-editable: stable ids, no generated noise.

## Top-level shape

```json
{
  "atlas_version": 1,
  "project": "string — repo or system name",
  "scope": "string — what slice this atlas covers, in one sentence",
  "generated_from": {
    "git_sha": "abc1234",
    "date": "2026-08-17",
    "dirty": false
  },
  "config_lens": "full | defaults-only",
  "particles": [ ... ],
  "external": [ ... ],
  "stages": [ ... ],
  "edges": [ ... ],
  "open_questions": [ ... ]
}
```

`config_lens` records the Phase 0 decision: `full` means effective values were
readable and the lens toggle renders; `defaults-only` means the atlas shows the
honest badge instead.

## particles

The units of flow. One journey each, 1–3 total.

```json
{
  "id": "query",
  "name": "User query",
  "description": "A question entering retrieval and leaving as a ranked result list",
  "color": "#4a90d9"
}
```

`color` is the particle's identity in the map and the trace — keep it stable
across refreshes.

## external

Black boxes at the boundary. Mapped by contract, not by internals.

```json
{
  "id": "consumer-api",
  "name": "example-api",
  "contract": "consumes SearchResult via the shared package; breaks if its shape or diagnostics keys change",
  "anchors": [{ "path": "search/models.py", "line": 12, "claim": "SearchResult is the wire shape" }]
}
```

## stages

The heart of the manifest. One entry per node on the map.

```json
{
  "id": "fusion",
  "name": "RRF fusion",
  "subsystem": "retrieval",
  "role": "Merges per-lane candidate lists into one ranked list via reciprocal rank fusion",
  "pos": { "x": 520, "y": 180 },
  "anchors": [
    { "path": "search/pipeline/fusion.py", "line": 42, "claim": "RRF k defaults to 60" },
    { "path": "search/pipeline/fusion.py", "line": 88, "claim": "weighted mode is selected by SEARCH_FUSION_MODE" }
  ],
  "config": [
    {
      "key": "SEARCH_FUSION_MODE",
      "code_default": "rrf",
      "effective": "rrf",
      "effective_source": "deployment settings, read 2026-08-17",
      "verified": true
    },
    {
      "key": "SEARCH_FUSION_K",
      "code_default": "60",
      "effective": "unverified",
      "effective_source": null,
      "verified": false
    }
  ],
  "inputs": ["per-lane candidate lists"],
  "outputs": ["single fused ranked list"],
  "metrics_hook": "diagnostics.fusion.candidates_in / candidates_out",
  "sharp_edges": [
    "silently degrades to identity order when only one lane returns candidates"
  ],
  "who_breaks_if_changed": [
    "rerank stage assumes fused order as its input baseline",
    "benchmark runner's MRR baseline shifts if k changes"
  ],
  "verification": { "verdict": "verified", "checked": "2026-08-17" }
}
```

Field notes:

- **`anchors[].claim`** — the specific sentence that anchor proves. One claim per
  anchor. This is what the Phase 2 gate re-checks and what the Phase 4 refresh
  re-resolves.
- **`pos`** — map coordinates. Part of the knowledge (spatial memory); refreshes
  keep them. New stages get positions that don't displace existing ones.
- **`config[].effective`** — a real value with a named source, or the literal
  string `"unverified"`. Nothing in between.
- **`metrics_hook`** — where trace mode gets real numbers, or `"none"`.
- **`verification.verdict`** — `verified` | `partial` | `unverifiable`. A stage
  whose every claim was refuted has no verdict — it has no place in the manifest.

## edges

```json
{
  "from": "lanes",
  "to": "fusion",
  "particle": "query",
  "payload": "candidate lists, one per lane"
}
```

Edges belong to a particle — that's what makes a coherent animated journey per
particle in trace mode instead of one tangled graph.

## open_questions

The visible residue of the Phase 2 gate — `unverifiable` claims and anything the
mapping surfaced but couldn't settle.

```json
{
  "id": "OQ1",
  "text": "Does the prod rerank endpoint's response schema match what parse_order expects?",
  "stage": "rerank",
  "needs": "prod logs or a live call",
  "blocking": false
}
```

## Validation checklist (run before Phase 3)

- every stage has ≥1 anchor and a one-sentence `role`;
- every `config[].effective` is a sourced value or `"unverified"` — no guesses;
- every edge's `from`/`to`/`particle` resolve to existing ids;
- ≤ ~12 top-level nodes per subsystem view;
- every open question has a `needs` — what would settle it.
