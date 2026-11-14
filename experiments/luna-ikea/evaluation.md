# First-pass evaluation

## Outcome

Promising implementation capability; fails the first-pass source-fidelity and display-readiness gate. Candidate left unchanged for comparison. This is a coding-agent trial, not evidence that a single OpenRouter request can generate the same result.

## Setup

- Requested model: Codex `gpt-6-luna`, inherited/default medium effort; no parent conversation supplied to the child. T3 records the selected model as gpt-6-luna but does not expose a separate executed-model value.
- Input: 16-page TROTTEN manual plus the existing app scaffold, component source and README.
- Prompt: `authoring-prompt.txt`. No assembly steps were prewritten by the evaluator.
- One agent run, about five minutes, no evaluator repairs or extra correction prompt.
- Codex supplied filesystem, terminal and image-inspection tools. Production API ingestion/tooling remains a separate experiment.

## What worked

- Built an executable TypeScript/React guide using the supplied components.
- Included the 140 cm and 160 cm source branches, common numbered steps, and source-page references.
- Added Previous/Next and Finish actions plus localStorage progress, with fallback when storage is unavailable.
- Packaged diagram assets locally, with no external runtime asset URLs.
- Baseline hash comparison found only src/main.tsx changed among existing scaffold files; new styles and diagram assets were added. No copied library or package configuration was changed.
- Agent reports successful build and the three baseline tests. Those tests check copy/ID guards; they do not exercise this applet's assembly content, navigation, or persistence.

## Material findings

1. **Source interpretation: step 1.** `commonSteps[0]` instructs the user to build complete matching leg frames. Source page 4's numbered action shows inserting two bolts into a rail; the completed-frame inset is context marked 2x. The prose substitutes a larger operation for the actual numbered step.
2. **Source interpretation: step 10, 140 cm.** Prose says to lower the tabletop onto the frame and attach brackets. Source page 10 depicts the leg/frame assembly above an upside-down tabletop, plus 2x brackets and 7x fasteners. The summary reverses the placement and omits the seven-fastener requirement. This is not adequately faithful instruction text.
3. **Additive display assets.** Images remain dark lines on opaque white full-page backgrounds. The CSS only sets width:100% and height:auto. There is no foreground/background adaptation for an additive display, no cropping into task-specific views, and no zoom control. An A4-shaped diagram displayed below copy at full content width also requires substantial scrolling. Device readability is unverified; these are visible design deficiencies in the source assets, not measured simulator results.
4. **Preparation omitted.** The parts/tool inventory on source page 3 is not exposed as a preparation screen or checklist. The introductory safety summary replaces the original pictorial page rather than retaining access to it. A complete source-fidelity audit is still needed; the sampled errors above already prevent acceptance.

## Other checks and limitations

The official static validator reports three findings. Two identify size-list labels as SubNavigation tab labels even though these are ChoiceScreen rows, and one flags product copy as implementation guidance. They appear to be heuristic false positives and are not the basis for rejecting this candidate.

No simulator/browser/hardware interaction was performed by this evaluator. Persistence and focus behavior were inspected in code, not verified interactively. No API cost or latency was measured. The current library has no dedicated source-diagram component; asking the model to invent image handling leaves an important display constraint unenforced.

## Implication

Luna can assemble the UI and local behavior with modest instructions and a capable tool environment. This trial does not support trusting its manual interpretation without verification. Next production-shaped experiment should use deterministic PDF page/region extraction, a display-safe diagram component, structured step data with source references and required hardware quantities, and checks that distinguish source-content accuracy from a successful build. Keep this candidate untouched as the baseline.
