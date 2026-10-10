# Vendor API notes

The CareLink surface this bridge talks to is undocumented by Medtronic. The
reverse-engineering that informed this fork's behaviour is published separately:

## **[`NovaLux12/carelink-api-research`](https://github.com/NovaLux12/carelink-api-research)**

| What you probably want | Where |
|---|---|
| **Start here** — one-page map of hosts, tenants, namespaces | [`docs/00-summary-the-map.md`](https://github.com/NovaLux12/carelink-api-research/blob/main/docs/00-summary-the-map.md) |
| The 16 published device families, and why family-matching is unreliable | [`docs/05-devices-and-vocabulary.md`](https://github.com/NovaLux12/carelink-api-research/blob/main/docs/05-devices-and-vocabulary.md) |
| The app-version axis — why the pin is `android/3.6` | [`docs/03-discovery-and-versions.md`](https://github.com/NovaLux12/carelink-api-research/blob/main/docs/03-discovery-and-versions.md) |
| The unauthenticated config file Medtronic publishes | [`docs/04-configuration.md`](https://github.com/NovaLux12/carelink-api-research/blob/main/docs/04-configuration.md) |
| Auth tenants and the code+PKCE flow | [`docs/02-auth-tenants-and-flows.md`](https://github.com/NovaLux12/carelink-api-research/blob/main/docs/02-auth-tenants-and-flows.md) |
| Security findings | [`docs/08-security-findings.md`](https://github.com/NovaLux12/carelink-api-research/blob/main/docs/08-security-findings.md) |

## What this bridge relies on, in one paragraph

The bridge pins `android/3.6` because that is one of only three discovery cells
(`3.6`, `3.7`, `3.8`) that select **both** Auth0 **and** cumulus v13 — issue
[ADR 0002](../adr/0002-discovery-app-version-pin.md) records the reasoning, and
the research repo records the evidence. It matches devices on **model prefix**
rather than family token, because the vendor's own published family list does not
contain the token their app matches on and the family spelling is demonstrably
inconsistent. And it tries several API versions per data endpoint, because the
country-settings config hands out a legacy `v6` route while the app advertises
`v13`.

## Running the regression suite

The research repo carries a pinned assertion suite that re-checks the vendor
surface without credentials:

```bash
git clone https://github.com/NovaLux12/carelink-api-research
cd carelink-api-research/regression/hurl
./run.sh          # exit 0 = the vendor surface has not drifted
```

If it ever exits non-zero, the assumptions this bridge is built on have moved,
and the change should be read before the next release.
