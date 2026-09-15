# OpenMAIC upstream baselines

CoTeach vendors selected OpenMAIC packages in this workspace. P0 synchronization is pinned to immutable release-tag commits so later upstream changes cannot silently alter a migration.

| Package | Release | Upstream commit |
| --- | --- | --- |
| `@openmaic/dsl` | `0.9.0` | `e15780835afbee2d96270fd37be868742308e0b9` |
| `@openmaic/generation` | `0.3.7` | release tree `v1.0.3@e693e11a81644f84c258df73dbda378643520a62` |
| `@openmaic/importer` | `0.1.2` | `90f5f3942bca09df33a85a2d8aa025faf46679f6` |

## Synchronization policy

- Synchronize shared schemas, migrations, validators, runtimes, import logic, fixtures, and package metadata from the pinned release.
- Keep CoTeach teaching-domain behavior in application-level extensions whenever the upstream generic types support it.
- If compatibility requires a temporary vendored-package extension, keep it additive, document it, and cover it with a regression test.
- Preserve CoTeach's Windows-compatible workspace scripts and maintained dependency substitutions.
- Port security fixes selectively when CoTeach already has stricter behavior; never replace the DNS-pinned SSRF dispatcher with a weaker implementation.
- Keep generation-owned one-click prompt assets byte-identical to the pinned package. CoTeach course metadata, timing, persistence, and quality checks belong in application adapters rather than copied prompt templates.

## Generation baseline

The low-level production first draft for slide content and slide actions is pinned to
OpenMAIC `v1.0.3` (`e693e11a81644f84c258df73dbda378643520a62`) /
`@openmaic/generation@0.3.7`. The package's prompt assets are
the immutable baseline; experimental visual plans and spatial budgets may be
used by offline benchmarks but must not be injected into production first-draft
prompts.

Verified again on 2026-09-15: `v1.0.3` is the newest stable `v1.x` tag and its
`packages/@openmaic/generation` tree has no changes relative to `v1.0.2`;
both releases use `@openmaic/generation@0.3.7` with the same six one-click
prompt assets. CoTeach records the newer release tag so quality reports name
the actual stable baseline being followed.

OpenMAIC v1.x has a classic one-click path and a newer Agent Workbench. CoTeach
production intentionally uses the pinned classic `requirements-to-outlines` →
`slide-content` → `slide-actions` path. The Workbench planner remains available
only to offline benchmarks and must not be reachable from durable production
jobs. Resource-package facts are supplied only through the official
material/PDF context, while grade, duration, section structure and teaching
requirements are supplied through the official requirement. CoTeach does not
repack facts into or rewrite the returned page descriptions/key points. It
filters generic upstream quizzes and appends one short-answer quiz after each
confirmed section.

The six official prompt assets stay byte-stable and their SHA-256 hashes are
recorded in `OPENMAIC_GENERATION_BASELINE`. CoTeach does not copy or edit those
files. For production lecture slides only, the thin call adapter appends one
shared reference profile measured from the teacher-supplied OpenMAIC web export:
deep-navy/slate colour roles, title/subtitle hierarchy, sufficient visible
teaching units, semantic structure selection, and an explicit rule that tables
are only for genuine two-dimensional comparisons. Projected body and table
text stays at 16px or larger; fit is solved by editing wording or composition,
not by shrinking teaching text. It supplies the course title
and ordered lecture-page titles for deck awareness. It does not supply IDs,
timings, quiz mechanics, coordinates, a page template, spatial budget, visual
plan, or a second model, and it never overwrites the returned background/theme.

The supplied OpenMAIC course export is used only as a visual measurement
reference because its input was a topic rather than the same CoTeach resource
package. Its actual elements use deep-blue title roles (`#1E3A8A` /
`#1E40AF`), slate body text, and white or light gray-blue surfaces. The Office
blue values in DSL theme metadata are not treated as the visual identity of the
rendered pages. Screenshot page numbers, outer rounded cards and page shadows
belong to the display shell and are not injected into the course DSL.

The page planner, media planner, slide-content generator, action generator and
assembler have deliberately separate responsibilities:

1. the official classic outline generator writes page order, title, type,
   description and source-grounded key points, including any semantic structure
   hints that the upstream model itself selects;
2. the official outline's media requests are preserved; CoTeach does not run a
   second media planner after the outline has been confirmed;
3. the unmodified `@openmaic/generation` slide prompt plus the shared website
   reference context produces the editable elements and page composition;
4. browser and static audits measure the returned first draft; only a concrete
   layout, density, knowledge-visibility, hierarchy, palette or semantic-
   structure defect may invoke the pinned package's editor once, using the
   exact same teacher-selected model. The candidate is adopted only when its
   measured quality improves and confirmed knowledge coverage is preserved;
5. action/TTS generation receives the semantic outline and final page, but not
   the visual contract.

Recovered slide checkpoints are re-audited before reuse. A checkpoint with
structural or browser-rendered layout defects is discarded and regenerated
through the normal official first-draft path. Density, palette and semantic-
coverage findings remain visible in the quality report but do not discard
already completed work during a continuation; an accepted checkpoint is never
silently reauthored by a heuristic alone.
The quality report records the exact generation model, classic baseline,
reference profile, density, palette, semantic structures, repair decision and
final disposition.

Standard production generation uses the package for outline, scene content and
scene actions, plus the upstream v1.x per-stage model routing semantics.
CoTeach-only section IDs, knowledge-point IDs, timing, quizzes, persistence and
quality metadata remain outside the package. Section quizzes are added only
after the teaching pages have been grouped. Before outline generation, their
reserved duration is removed from the duration shown to the upstream lecture
planner; otherwise OpenMAIC spends the full course budget on slides and CoTeach
then adds quizzes on top, producing many sparse pages. The only separately owned planners
are specialized six-stage PBL and vocational task-engine generation.

The browser quality pass combines actual renderer geometry with knowledge
coverage, body-grid use, title/subtitle hierarchy, palette measurements,
semantic structure selection and cross-page layout repetition. Each page has
at most one evidence-triggered editor call and no retry loop. Unresolved pages
are marked `needs-review`; browser unavailability records `audit-unavailable`
and keeps the first draft without attempting an edit.

Interactive widgets still use the teacher-selected generation model. Because
the official widget path returns a complete HTML/CSS/JS document rather than a
compact slide JSON object, widget content receives one bounded long-generation
request as a streamed response instead of multiple short page requests. The
caller still consumes the final response as one text document, but receiving
response headers while generation is in progress prevents the HTTP transport's
shorter header timeout from pre-empting the application deadline. This changes
neither model routing nor the official widget prompt and prevents a late diagram
timeout from replaying completed slide checkpoints.

Course language is resolved before slide and action generation, including when
a teacher-confirmed outline skips upstream outline generation. Chinese courses
require Chinese learner-facing text and narration while allowing necessary
English terms with Chinese explanation. English-dominant narration receives at
most one action-only repair; a final TTS preflight refuses to synthesize it if
the repair still fails.

## Current compatibility extension

CoTeach stores optional `knowledgePointIds` and pedagogical `format` metadata on quiz questions. These additive fields survive the DSL 0.9 migration and remain readable by existing classrooms.

Existing classrooms and media-generation code also still read `SpeechAction.audioUrl`. DSL 0.9 prefers `audioId` asset references, so `audioUrl` remains as a deprecated additive compatibility field until persisted classroom migration is complete.

CoTeach's current product flow treats deep interaction as the default and has removed the old stage-level `interactiveMode` switch. The optional DSL 0.9 field is therefore intentionally not reintroduced; `taskEngineMode` remains the specialized vocational-path marker.
