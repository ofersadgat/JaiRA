---
id: engineering/units/forge-integrations
type: engineering-unit
status: shipped
updated: 2026-09-23
implements: [product/review-changes-before-they-land, ux/patterns/checked-status-with-the-fix, ux/patterns/secret-goes-in-never-comes-back, ux/patterns/refuse-with-the-reason-and-the-fix]
layer: core
owns_contracts: []
requires: [engineering/units/secret-chain, engineering/units/project-config, engineering/units/user-settings, engineering/units/ipc-bridge]
implemented_by: [packages/shared/src/forge.ts, packages/runtime/src/forge/index.ts, packages/runtime/src/forge/http.ts, packages/runtime/src/forge/github.ts, packages/runtime/src/forge/gitlab.ts, packages/runtime/src/forge/deviceFlow.ts, packages/app/src/main/service.ts]
verified_by: [packages/shared/test/forge.test.ts, packages/runtime/test/forge.test.ts, packages/runtime/test/deviceFlow.test.ts, packages/app/test/integrations.test.ts, packages/app/test/forgeSignIn.test.ts]
siblings: [engineering/units/secret-chain, engineering/units/model-routing, engineering/units/agent-executors]
---

# Forge integrations

## The unit turns a forge connection into a provider, checks who its token is, and signs a person in through the browser

[Decision 0004](../decisions/0004-remote-review.md) §1 is the design; this is what the code does.

- **The `integrations` block.** `parseIntegrations` in `@jaira/shared` `forge.ts` reads `forges` (connections by name: `{provider, host, credential?, enabled?, apiUrl?}`, with `gitlab` and `github` built in), `review.settleAfter`, and `oauth` (an OAuth app's `clientId` per provider). The fields are in [settings-json](../contracts/settings-json.md).
- **Providers.** `forgeProvider(connection, token)` builds `GitLabProvider` or `GitHubProvider` over the `ForgeHttp` seam; `forgeForHost` picks one by a git remote's host and resolves its token through the [secret chain](secret-chain.md). Both send the token as `Authorization: Bearer`, which GitLab takes from a personal access token and an OAuth token alike (`PRIVATE-TOKEN` takes only the first).
- **The check.** `checkForge` asks the host `GET /user` and reports a `ForgeCheck`: `ok` with the identity, `failed` with a `fix`, `unconfigured` when no token resolves, `disabled`. `via` says whether the token in use came from a sign-in (`oauth`) or a paste (`token`). The app runs the check in every availability pass, into `AvailabilitySnapshot.forges`.
- **Sign-in through the browser.** `deviceFlow.ts` is RFC 8628's device authorization grant, pure over `ForgeHttp`, a clock and a `sleep`: `deviceFlowEndpoints`, `requestDeviceCode`, `pollDeviceToken`, `refreshDeviceToken`, `oauthAppNeeded`. `AppService` wires it to `forge:signIn`, `forge:cancelSignIn`, `forge:signIns`, `forge:signOut` and the `forge:signInFinished` push ([ipc-channels](../contracts/ipc-channels.md), [push-messages](../contracts/push-messages.md)).

It deliberately does not own:

- Where a secret's value lives and in what order it is found: [secret-chain](secret-chain.md). A sign-in stores its token through the same `writeSecret` path `secret:set` uses.
- The merge request primitives, the poller and the gate's second door: `remote.ts`, `remoteWatch.ts`, `remoteReview.ts` (decision 0004 §2–§3).
- Drawing Settings → Connections. The renderer calls the channels; nothing here renders.

## A sign-in is polled in main, stored like a paste, and tagged in the preferences file

```text
forge:signIn {connection}
  └─ the connection's oauthClientId, else JaiRA's own on its public host?  ── none ──▶ {ok:false, reason, fix}   (no request is made)
  └─ POST {web}/login/device/code | /oauth/authorize_device   (client_id, scope; form-encoded)
  └─ answer {ok:true, pending:{userCode, verificationUri, expiresAt}}
     and open verificationUri in the browser — never verification_uri_complete: gitlab.com says
     "Device successfully authorized" through it and then answers the poll invalid_grant
        └─ every interval: POST {web}/login/oauth/access_token | /oauth/token  (grant_type=…:device_code)
             authorization_pending → wait   slow_down → interval + 5 s (or GitHub's own, if longer)
             expired_token | clock past expiresAt → expired      access_denied → denied
             Cancel / app closing → canceled   three unreachable polls in a row → failed
        └─ token → writeSecret(connection.credential, keychain ?? base-env-local)
                   + <credential>_REFRESH beside it when the forge gave one
                   + user-settings.json forgeSignIns[<credential>] = {provider, host, source, at, expiresAt?, refreshCredential?}
                 → availability pass (the check names the account) → push forge:signInFinished
```

- The app: the connection's `oauthClientId`, else JaiRA's own on its public host (`oauthClientIdFor`, `BUILTIN_OAUTH_APPS`: GitHub App 5053987 on github.com, a GitLab application on gitlab.com). Per connection because an app is registered on one host: a self-hosted instance's app means nothing to gitlab.com. Client IDs only — no secret is shipped or sent. A self-hosted host with no app named is refused before anything is asked. A renewal goes through the same connection's app, found by the mark's host.
- Scopes are fixed per provider: GitHub `repo read:org` (a GitHub App ignores scopes; what its token may do is the app's permissions, in the repositories it is INSTALLED on), GitLab `api` (`DEVICE_FLOW_SCOPES`) — JaiRA's GitLab app does not allow `read_user`, and a scope an app lacks refuses the whole request.
- The web root is `https://<host>`, or a connection's `apiUrl` with `/api/v4` or `/api/v3` taken off, so a forge behind a path prefix works.
- A connection naming no `credential` gets `<NAME>_TOKEN` written into the configuration layer that defines it, as a pasted token's name would be.
- **Renewal.** A mark with `expiresAt` and a `refreshCredential` (GitLab's two-hour tokens) is renewed with `refreshDeviceToken` at the start of any availability pass that finds it within five minutes of dying, and one timer (`scheduleForgeRenewal`, unref'd, cleared at close) starts that pass in time while the app is open. GitHub OAuth-app tokens carry no expiry and are never renewed. A GitHub App's user tokens expire after eight hours when the app has token expiry on, and GitHub renews them only with the app's client secret, which JaiRA does not have — so the app has expiry turned off; with it on, a sign-in lasts eight hours.
- **Disconnect.** `forge:signOut` removes the token from where the chain FINDS it (keychain, `<base>/.env.local` or `<project>/.jaira/.env.local`), the refresh token and the mark, then re-checks. It does not revoke the grant on the forge: GitHub's revocation endpoint needs the app's client secret, which a public client does not have.

## The data it owns

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `integrations` block | read by `parseIntegrations`; `nameForgeCredential` writes a missing `credential` | the two `settings.json` layers | [project-config](project-config.md), Settings |
| Forge tokens and refresh tokens | written by `storeForgeToken` / `markForgeToken`, removed by `signOutForge` / `dropForgeMark` | the keychain, else `<base>/.env.local` | [secret-chain](secret-chain.md); `secret:set` for pasted tokens |
| `forgeSignIns` marks | written by `markForgeToken`, removed by `dropForgeMark` (through `saveForgeMarks`, which can delete the field) | `<base>/user-settings.json` | [user-settings](user-settings.md) parses them forgivingly |
| Sign-ins in progress | `forgeSignIns` map in `AppService` | memory; a restart forgets them and the code dies on the forge | `forge:signIns` lists them |
| Provider cache | `forges` map in `AppService`, keyed by project and host | memory; cleared by every secret and config write | the poller |

## The invariants

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | No OAuth app configured answers `ok: false` naming `integrations.forges.<name>.oauthClientId`, and makes no request; a connection's own app is asked on its host only | `forgeSignIn.test.ts` "says an OAuth app's client id is needed…", "signs in to a self-hosted instance through the app the connection names…" |
| 2 | A second start while one waits answers with the same code: one device-code request, one browser window | `forgeSignIn.test.ts` "answers with the code, opens the page…" |
| 3 | A pending poll waits the interval before every request; `slow_down` adds five seconds for every later poll | `deviceFlow.test.ts` "waits the interval before every poll…", "slows down by five seconds…" |
| 4 | GitLab's `400 authorization_pending` reads as pending, not as a failure | `deviceFlow.test.ts` "reads GitLab's pending as pending…" |
| 5 | Expired (by the forge or by the clock), denied and canceled end with their own `code`, and nothing is stored | `deviceFlow.test.ts`, `forgeSignIn.test.ts` "ends as denied…", "ends as canceled…" |
| 6 | A signed-in token lands under the connection's `credential` in the keychain, and the check after it says `via: "oauth"` with the account | `forgeSignIn.test.ts` "stores the token where a pasted one goes…" |
| 7 | A paste over the token in the same store drops the mark and the refresh token; a token found anywhere else reads as `token` | `forgeSignIn.test.ts` "drops the OAuth tag…", `forge.test.ts` "says a token came from a sign-in only while…" |
| 8 | Disconnect removes a token only from a place JaiRA writes, and names the place otherwise | `forgeSignIn.test.ts` "disconnects a pasted token the same way, and refuses one in a file…" |
| 9 | A token within five minutes of dying is renewed before the check asks about it | `forgeSignIn.test.ts` "renews a token about to die…" |
| 10 | A token's value is never in a check, a snapshot or a settings file | `integrations.test.ts` "never lets the token's value out of main…" |

## The failure modes

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| A self-hosted connection with no `oauthClientId` | `forge:signIn` answers `{ok:false, reason, fix}` | set the connection's sign-in app, or paste a token | the reason and the fix beside Sign in |
| The GitHub app has device flow off, or the forge does not know the client id | the start answers `ok: false` naming the box to tick or the setting to check | fix the app or the setting | the reason beside Sign in |
| Nobody types the code in time | `forge:signInFinished` `{code:"expired"}` | sign in again | a new code is needed |
| The network drops for three polls in a row | `{code:"failed"}` naming the host | sign in again | the reason |
| The app closes mid-sign-in | the poll is aborted; `{code:"canceled"}` is pushed to a window that is going away | sign in again after restart | nothing waits |
| No keychain here | the token goes to `<base>/.env.local`; a token in a project's `.jaira/.env.local` under the same name is found first | remove the project's copy | the check names the other token, `via: "token"` |
| A renewal fails (refresh token revoked, app deleted) | logged at `warn`; the old token stays | sign in again | the check reports the token refused with "sign in again" |

## What migrates

- GitLab requests now send `Authorization: Bearer` instead of `PRIVATE-TOKEN`; personal access tokens keep working, and the recorded fixtures' header matches moved with it.
- `forgeSignIns` is new and absent until a sign-in. Nothing reads an older form.
- 2026-09-25: the provider-wide `integrations.oauth.<provider>.clientId` became each connection's `oauthClientId` — one id per provider made a self-hosted instance's app the one gitlab.com was asked with. No settings held the old block; it is now refused as not a setting.
