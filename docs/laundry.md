# Laundry coach (care labels → sorting plan → washing steps)

Status (2026-11-15): **MVP built** on the task-coach foundation. Checked with
fixtures, the free fake models, Chrome at 600×600 and a real API/worker on
PostgreSQL (Aiven, throwaway databases). **Not checked with a real vision
model, in the Meta simulator extension, with Meta AI, or on the glasses.**

## What it does

1. **Phone: capture.** "Laundry from care labels" on the home screen starts a
   session. For each garment: a name and a label photo (camera or file).
2. **Phone: review.** The `extract_care_label` job reads the photo. Every
   instruction comes back **unconfirmed** with its status, distinguishing "not
   on label", "unreadable" (blurred or conflicting) and "read from label", plus
   what the label shows. The wearer confirms each field or corrects it (marked
   "you corrected this"). Unclear washing instructions ask for a clearer photo
   or manual entry. Fibres, colour, new / colourfast and stains are kept apart
   from care instructions.
3. **Phone: plan.** The rule engine groups garments live. Unanswered details
   (colour, new, colourfastness) are listed as questions, never assumed.
   **Send to glasses** stays disabled until every label is confirmed. The
   draft is saved as a revision after each change, so closing the app loses
   nothing.
4. **Glasses: guidance.** One action per screen: set-aside piles, then each
   group's sort ("Group 3: add Navy jeans, Black tee") and wash (clearly
   labelled *suggested* settings to match on your washer), hand wash, drying
   groups, done. The dock has **Previous** and **Confirm sorted / Wash done /
   Drying done** (Next once confirmed). **More** opens Show label, Explain
   grouping, Ask a question, Report a change and Undo. Small label thumbnails
   appear under the step.
5. **Questions, all local with no AI request:** "Why is this separate?",
   "Can these go together?", "What does this symbol mean?". Answers cite the
   confirmed label ("Label: …"), the wearer ("You said: …") or the rule ("Rule: …").
6. **Changes:** "This garment is new", "I already put X in the machine", "My
   washer doesn't have that cycle". Each asks a focused question, then shows a
   **proposed change** (who moves where, and why). Nothing moves until the
   wearer chooses **Change plan**. **Keep plan** declines, and Undo reverts an
   accepted change. For an unsuitable cycle that already started, it says what
   is known, says it can't tell what will happen, refers to the garment's label
   and the washer's instructions, and offers only to move the garment to "check
   after washing". There are no rescue steps.

## Rules (`packages/laundry/src/plan.ts`)

The rule engine, not a model, makes every grouping decision, using only
confirmed instructions and the wearer's answers:

- **Machine groups** need the same cycle, the same label temperature and the
  same colour class. The lowest temperature alone never combines garments.
- **Wash alone:** new dark or bright garments of unknown colourfastness, and
  anything known to bleed.
- **Never in a machine group:** hand-wash, do-not-wash and professional-only
  items.
- **Check first:** unconfirmed, unreadable, missing-instruction, no-temperature,
  unknown-colour and stained items. A missing symbol is never permission.
- **Drying** is grouped separately: tumble by exact heat, line, flat, drip, no
  tumble. A missing or unreadable drying instruction means "don't tumble; check
  the garment".
- **Bleach** for a group is the most restrictive member's. Settings always say
  "Suggested (match on your washer)". On the glasses the wash step shows only
  the short program (so it fits) with the hint "Suggested; check your washer".
- **Never done:** stain-treatment recipes (stained items are flagged for
  review), chemical mixing, overriding a label, or guarantees against
  shrinkage, dye transfer or damage.

## Care-symbol reference

`packages/laundry/src/symbols.ts` gives plain-language meanings with their
source: **ISO 3758:2023** (most regions) and the **US FTC Care Labeling Rule
(16 CFR 423) / ASTM D5489**. Meanings are paraphrased. **No symbol artwork is
reproduced:** the ISO symbols are GINETEX registered trademarks and need a
licence. Labels can be read against `iso` or `us`; the phone uses `us` today.

## Architecture: what's shared and what's laundry

| Shared engine (reused) | Laundry-specific |
| --- | --- |
| Uploads, storage, job runner, model adapter with fake providers | `extract_care_label` job, `LABEL_MODEL` (default free `fake:labels`) |
| Revisions, publish, package, pairing, sync, state backup | `task: { kind: "laundry", version: 1, data: { region, garments } }` in the definition |
| `AppletState.task` (saved before acknowledged, migrated, backed up) | `task.laundry`: accepted adaptations, confirmations, undo stack, history, pending question/proposal |
| Task-module registry (`applet-renderer/src/tasks.ts`): screen + voice tools per `task.kind` | `packages/laundry/src/ui.tsx` (`laundryModule`) |
| WebMCP conventions: return at once, validate args, manual path for every tool | 16 `j26_<prefix>_…` laundry tools |
| Confirm-before-change pattern from the coach's recovery branches | Proposals built by re-running the rules with candidate overrides |

The plan is always rebuilt from **confirmed garments + accepted overrides**.
So the original plan, every accepted adaptation and Undo stay reproducible.
Confirmations are keyed by stable step IDs (they name the group), so progress
on unchanged groups survives a plan change. A changed pile asks to be confirmed
again. Confirm commands carry the step they were meant for, so a duplicate or
retried voice call can't confirm the next step.

### Reusing this for future tasks (crochet, repair, practice, plant care)

A new task adds a package like `packages/laundry`:
- its own `task.kind`, data schema and pure state;
- a `TaskModule` (screen + tools) registered in `apps/glasses/src/main.tsx` and
  the phone preview;
- optionally a job kind for its source material.

Reusable as is:
- the task slot in the format and saved state;
- the module registry;
- `session.update`, persistence and sync;
- the job, upload and model plumbing with fake providers;
- the coach's request runner pattern for AI questions;
- the glasses-ui paging and card patterns;
- the confirm/decline/undo approach.

## Fixtures

All original, Apache-2.0: `packages/laundry/src/fixtures.ts` holds 11 garments,
and `fixtures/labels/*.png` holds printed-text labels with no symbols,
regenerated by `scripts/laundry/make-labels.ts`. Coverage:
- compatible machine-wash items (navy jeans + black tee);
- different temperatures (towels 60°C vs white tee 40°C);
- hand-wash only (blue sweater);
- do-not-wash / dry-clean only (silk blouse);
- tumble vs line vs flat drying;
- an unreadable label (linen trousers, blurred);
- a conflicting label (striped shirt);
- a new bright garment with unknown colourfastness (red flannel);
- an extraction mistake the wearer corrects (grey hoodie: read 60°C, label 40°C).

The glasses bundle the confirmed set as the "Laundry: Sunday load" example.

## Evidence

| Layer | What ran | Result |
| --- | --- | --- |
| Unit (fixtures) | `packages/laundry`: grouping constraints, set-aside rules, separate drying, missing ≠ permission, correction, explanations, symbol lookup, explicit/undoable/repeat-safe confirmations, adaptations with clarify → proposal → accept/decline/undo, progress kept after a mid-session change, no rescue promises, extraction normalization, copy budgets | 13 pass |
| API + worker on PostgreSQL (Aiven, throwaway DBs), fake models | `apps/api/src/laundry.test.ts`: upload label PNG → read → unconfirmed fields with sources and a < 8 KB thumbnail; blurred label unreadable; unrecognized photo all unreadable + clearer image; non-image refused; owner-scoped; one job per photo; confirmed session publishes and the package carries the task | Pass |
| Browser, glasses at 600×600 (dev WebMCP stub) | `apps/glasses/browser-tests/laundry.spec.ts`: D-pad focus/Enter, no scroll, fit guard, Show label, Explain, Undo, "can these go together", symbol meaning, concurrent duplicate confirmations, washer-cycle change after sorting (question → proposal → confirm), reopen restores the adapted plan and progress, "already in the machine" offers no rescue, unknown garment refused | Pass (stable over repeats) |
| Full local stack, manual (Chrome; phone view 375×812, glasses 600×600) | Dev sign-in on localhost only; phone added 6 garments from fixture photos, corrected the hoodie, confirmed labels, answered colour/new, saw the plan; reload restored the draft; Send to glasses published; glasses paired and synced; step 1 showed the sweater with its thumbnail | Pass |
| Meta simulator, Meta AI, real vision model, glasses | not run | **Not verified** |

## Remaining checks and limits

- **Label interpretation:** the fake reader recognizes fixture file names
  only. A real vision model (`LABEL_MODEL`, paid, needs authorization) is
  untested on real labels: faded prints, multilingual text, dot temperatures,
  ISO vs US symbol differences, symbols without words. Region choice isn't
  exposed on the phone yet.
- **Laundry domain:**
  - colour classes are coarse (white / light / bright / dark);
  - there's no load-size or weight check;
  - permanent press vs delicate equivalence on real washers is a general
    suggestion only;
  - "wool program" substitution is offered as a suggestion, never as a label
    override;
  - stain handling is out of scope.
- **Phone:** garments added on the glasses can't exist (by design). Removing a
  garment after publishing needs a new publish. Garment photos (rather than
  label photos) aren't captured, so thumbnails show the label.
- **Glasses:** the step list for a big load is long (one screen per pile,
  group and drying group). The home screen's three-button dock issue when
  paired with more than three solutions still exists.
- **Free-text questions:** questions outside the three supported kinds
  aren't sent to a model yet. The coach's `coach_request` path could be
  extended with label passages.

## Hardware checklist (minimal)

1. Record glasses firmware and Meta AI app versions; Developer Mode on (restart
   glasses and app after toggling).
2. Serve the glasses build over public HTTPS (see apps.md, "Testing on real
   glasses"); never expose `AUTH_MODE=dev` publicly.
3. On the phone: add 3–4 real garments with label photos (real model only with
   authorization), confirm, send; on the glasses: Sync.
4. Band only: D-pad focus visible at edges, each pinch confirms once, More menu
   pages, Show label, Explain, Undo, Back to the library.
5. Voice: "Hey Meta, can the sweater go with my towels?", "what do two bars
   mean?", "this shirt is new", "I already put the sweater in the machine",
   "sorted". Verified **only** if the app logs a real tool callback.
6. Airplane mode: reopen from the app grid, continue confirming, ask the local
   questions; reboot and check progress survives.
7. Thumbnails readable on the additive display at arm's length; no dark panels.
