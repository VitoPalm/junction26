# Demo video (Junction 2026), ~3:00

Pitch: **more than basic mirroring.** The glasses don't just show the manual;
you talk to the guide about the step you're on, it recovers when you get
something wrong, and it keeps your place. The guide is one **block**: blocks
are templates for hands-free help (step guide, counter, checklist, live
dashboard, laundry plan) that get applied to many everyday situations.

## Assets

| Kind | Source | Where |
|---|---|---|
| Scenes (AI) | `generate.ts` → OpenRouter Veo 3.1 Lite, 720p, no audio; first frames from Seedream for the recurring character | `.data/demo-video/clips/*.mp4` |
| Voice-over (AI) | `generate.ts voice` → Gemini Flash TTS: narrator `Kore`, wearer `Puck`, agent replies `Aoede` | `.data/demo-video/voice/*.wav` |
| Glasses UI (real app) | `ui/` Playwright recordings, 600×600 on pure black | `.data/demo-video/ui/` |
| Phone UI (real app) | `ui/` recording of the authoring app, 393×852 | `.data/demo-video/ui/` |
| Real-device proof | Film the D&D sheet on the glasses: "Hey Meta, take five damage" | shoot by hand |

Text and prompts: [shots.json](shots.json), [voiceover.json](voiceover.json).
Commands: see the header of [generate.ts](generate.ts). Paid steps need `--paid`
and never overwrite existing files (delete a file to regenerate it).

## Compositing the glasses display

Put the glasses UI clip on top of the POV clip with blend mode **Screen**
(black becomes transparent, like the additive lens). Scale it to roughly a
third of the frame height, upper-centre-right (the right lens), with a slight
glow and ~90% opacity. No dark panel behind it. Add a small corner label
**"Display simulated · real app"** on every composite.

## Timeline

Pauses: when the wearer speaks (`W:` lines) the narrator is silent. Keep about
0.5 s before and 1.5 s after each spoken input, and hold the UI on the input
screen while the line plays, so the viewer sees the input, then the result.

| Time | Picture | Overlay | Audio |
|---|---|---|---|
| 0:00 | `h01-hook` | — | VO 01 |
| 0:08 | `h02-phone` → cut to phone UI recording (library → + → attach manual → generating → preview → Publish), sped up | phone UI full-screen in a phone frame | VO 02 |
| 0:30 | `h03-glasses-on` | — | VO 03 |
| 0:34 | `h04-pov-steps` | `ui/01-home` → `ui/02-steps` | VO 04, band "click" SFX on each Next |
| 0:46 | `h05-pov-screws` | `ui/03-ask` (question screen while W speaks, then the answer) | VO 05 · *pause* · **W 06** · *pause* · VO 07 |
| 1:02 | `h06-backwards` | — | **W 08** |
| 1:08 | `h07-pov-fix` | `ui/04-problem` (proposed fix → Use this fix → Fix 1 of 3 → back) | VO 09 |
| 1:24 | `h08-doorbell` | — | doorbell SFX, VO 10 |
| 1:30 | `h09-next-day` | `ui/05-resume` | VO 11, caption "Offline. Saved on the glasses." |
| 1:40 | `b01-cooking` | a step-guide frame | VO 12 |
| 1:45 | `b02-crochet` | `ui/07-counter` | VO 13 · caption chips: Step guide · Counter · Checklist · Dashboard |
| 1:51 | `b03-laundry` | `ui/06-laundry` | VO 14 |
| 1:58 | `b04-tabletop` → **real device clip** | `ui/08-dnd` | VO 15 · **W 16** (use the real on-device audio if the take is clean) |
| 2:10 | `b05-bike`, `b06-workout`, `b07-meds` quick cuts | — | VO 17 |
| 2:20 | Screen recording: Claude/ChatGPT connector creating a Solution, then the change-review screen ("you'd lose your inventory") | — | VO 18 |
| 2:38 | Architecture card: manual → model → checked applet data → glasses runtime (offline) ← band / Meta AI via WebMCP | — | VO 19 |
| 2:50 | `h10-done`, then logo/title | — | VO 20, music out |

Music: one light royalty-free track under everything at −20 dB, ducked under VO.

## Structure (current)

Four struggle → solved situations: **assembly** (main story, ~1:40), then
**cooking**, **laundry** and the **game table** (~15 s each), a blocks montage
(crochet, bike, workout, meds), voice notes on the phone, how it works, close.
The timeline in `rough_cut.py` is the source of truth; the table above is the
first draft. When the wearer asks the agent something directly, the agent
answers aloud (voice `agent`); the narrator stays silent during the exchange.

## Honesty notes (Meta judges will check)

- Spoken agent replies are illustrative for the assembly guide: on the device,
  Meta AI speaks a tool's result only when WebMCP invokes it, which has been
  observed for the D&D sheet, not for the guide. Add a small "illustrative" tag
  on those exchanges, or replace them with a real take if one works.

- Scenes are AI-generated; UI overlays are the real app recorded in Chrome, so
  they're labelled "display simulated". Only the D&D clip is filmed on the device.
- Voice: the D&D "take five damage" flow has worked on the device (owner report,
  2026-11-14). Asking the assembly guide by voice is **not verified on device**:
  the overlay shows the on-screen Ask flow. Don't claim it was spoken to Meta AI
  unless a take on the glasses works.
- The task coach has not yet run with a real model. Do one paid Luna run on the
  TROTTEN manual before final recording, or keep the fixture-based recording.
