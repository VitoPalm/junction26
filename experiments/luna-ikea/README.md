# Luna IKEA authoring trial

Model: Codex `gpt-6-luna`, default medium reasoning.
Input: downloaded TROTTEN underframe assembly PDF.
Prompt: `authoring-prompt.txt`, provided without parent conversation history.
Baseline: the basic components library and Vite example scaffold.
Dependencies are shared read-only by convention with the original package; agent is instructed not to change them.

Evaluation: first-pass build and component-contract compliance; source-step coverage and warning fidelity; diagram usefulness; forward/back navigation and retained progress; offline assets. Record corrections separately instead of silently repairing the candidate. This trial uses a coding agent with tools, not a single backend JSON generation call, and does not establish cloud token cost or latency.
