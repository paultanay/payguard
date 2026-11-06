# PayGuard Submission Readiness Plan

## Goal
Make the existing PayGuard prototype build cleanly, preserve reproducible offline testing, and make the gap between simulator, AI fallback, and actual PayPal Sandbox behavior explicit for hackathon judges.

## Scope
- Fix `CreateIntentInput` so defaults in the Zod input schema remain optional at API call sites.
- Declare the OpenAI SDK dependency used by the optional AI adapter.
- Add regression coverage for defaulted intent inputs and verify the full test/build commands.
- Reconcile stale README/status claims and make run/demo instructions internally consistent.
- Do not claim live PayPal, AI, MCP, or hosted behavior without observed evidence.

## Approach
Fix the shared schema type and declared dependency, then align the top-level setup and demo narrative with current event requirements. Avoid changing the payment architecture under the deadline. PayPal Sandbox credentials and a live buyer approval flow are external prerequisites and will be left as an explicit manual verification item.

## Verification
Run the existing test suite and production build after changes. Report PayPal Sandbox and live AI as unverified if credentials are unavailable.
