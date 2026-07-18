## What does this PR do?

<!-- One-paragraph summary. If it fixes a bug, say so. If it adds a feature, link to the issue it addresses. -->

## Related issue

<!-- Link to the GitHub issue this fixes or addresses, e.g. "Fixes #12" or "Addresses #8". -->

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to change)
- [ ] Documentation / README update
- [ ] CI / build / dev tooling

## How was this tested?

<!--
Describe the tests you ran. For unit tests: which files changed, what cases?
For real-CareLink testing: only do this with your own account, only with credentials
you control. NEVER commit credentials or logindata.json.
-->

- [ ] `npm test` passes locally
- [ ] `npx tsc --noEmit` passes locally
- [ ] Tested against real CareLink data (describe above)
- [ ] Tested against mocked fixtures only

## Upstream relationship

<!--
Does this change diverge from domien-f/carelink-bridge?
If so, why, and is there an upstream PR or issue that should be linked?
The fork should only carry changes that landed in or were submitted upstream.
-->

- [ ] No divergence — the change is also applicable to (or already submitted to) upstream
- [ ] Diverges from upstream — see explanation above

## Checklist

- [ ] My change matches the contribution guidelines in CONTRIBUTING.md
- [ ] I haven't introduced new dependencies without justification
- [ ] I've added tests for the behaviour change
- [ ] I've updated relevant docs (README, ROADMAP, etc.) if needed

## Security

- [ ] No credentials, tokens, or `logindata.json` content is included in this PR
- [ ] No new external network calls without justification
- [ ] No patient-identifying data is included (sample IDs, care-partner usernames, etc.)