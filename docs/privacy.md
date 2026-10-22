# Privacy Policy

Jiran is local-first. It processes AI-tool usage logs on the device and does not send analytics or telemetry to the project maintainer. The project does not operate a hosted data-collection service.

## Network features

Jiran makes network requests only for documented or user-enabled features:

- Packaged builds check GitHub Releases for updates.
- The exchange-rate lookup fetches its public data source.
- Quota accounts you add to the Hub contact their provider when the Hub refreshes them. A credential you pasted or an OAuth sign-in you completed is sent only to that provider; the desktop app itself does not probe provider accounts or upload local credentials.
- Multi-device sync sends data to the hub URL configured by the operator.

These requests are processed under the privacy policy of the service receiving them, including the [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) for update checks. Review the applicable provider's privacy policy before enabling a provider-backed integration.

## Multi-device sync

Multi-device sync is optional and has no Jiran-operated default server. The operator chooses and controls a Docker Compose Hub deployment and its infrastructure.

When enabled, sync can send device identifiers and metadata; aggregate token and cost totals; client, model, session, and project attribution; and retained usage history. Project attribution can include an opaque project identifier and workspace-folder label, but never an absolute workspace path. Devices do not upload provider quota: the Hub refreshes the accounts you added there — keeping a hashed account identifier, account email, and plan label so it can distinguish accounts — and pushes the normalized limit status back down to connected clients.

Sync also carries manually recorded subscription metadata when any exists: the plan name, amount, currency, billing cadence, dates you entered, and the account each record is bound to. These are values you typed in, never read from a provider, and they are stored once per hub rather than per device. The public stats endpoints never expose them.

Sync does not send raw AI logs, prompts, source code, conversation content, OAuth credentials, access or refresh tokens, provider cookies, API keys, or raw provider responses. The revocable device-session token is sent only to the configured Hub as an authentication header (or the browser host's HttpOnly cookie); it is not sent to the project maintainer or any third party. See the [API documentation](API.md) for the current wire format and public-endpoint redactions.

Data retention and access on a synchronized deployment are controlled by the operator of that hub and its infrastructure provider.

