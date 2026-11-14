# TROTTEN assembly guide

Implemented a glasses-first, one-step-at-a-time guide for both 140 cm and 160 cm TROTTEN desks. It includes the manual's assembly diagrams, source PDF page references, a brief safety/start note, and Previous/Next navigation. The selected desk size and current guide step are saved in browser local storage, so selecting the same size after reopening resumes where you left off.

## Validation

- `npm run build` — passed. Vite reports its existing large-chunk advisory (578 kB minified JS).
- `npm test` — passed (3 tests).

## Uncertainties and limitations

- The safety page communicates through unlabeled illustrations. The start note summarizes the visible two-person handling, floor protection, and IKEA-help guidance; it does not add torque values or tool steps absent from the manual.
- The manual's diagrams remain page-based images, so some screens need scrolling to see the complete drawing. Simulator rendering, directional focus, and readability on actual Meta glasses were not verified.
- Progress depends on browser local storage. If storage is unavailable or cleared, the guide still works for the current session but cannot resume after closing.
