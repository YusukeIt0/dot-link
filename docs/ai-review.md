# Opus pull-request review

The public repository provides a manually started **Opus PR Review** workflow.
It reviews an open, non-draft PR from this repository targeting `main` and posts
a comment review tied to the inspected commit. It never approves, merges, or
modifies the pull request. Existing test workflows remain separate.

## One-time authentication

Use Claude Code's official `claude setup-token` flow with a Claude subscription.
Store the resulting token as the repository Actions secret
`CLAUDE_CODE_OAUTH_TOKEN`. Never paste the token into a chat, issue, workflow,
or committed file. The workflow has no API-key fallback.

The workflow uses GitHub's short-lived job token, so no additional GitHub App
or personal access token is required. The review job has read-only repository
access; only the reporting job can post a PR review. The reporting job does not
receive the Claude credential.

Subscription limits and any enabled extra-usage settings still apply. Workflow
timeouts and turn limits bound execution but are not a monetary spending cap.
Dedicated Claude cloud-session promotional credits are not assumed to apply.

## Run a review

1. Open the PR and mark it ready for review.
2. Open **Actions → Opus PR Review → Run workflow**.
3. Select `main` and enter the PR number.
4. Read the resulting PR review and the Actions run result.

No push, issue, or comment starts this workflow automatically. Fork PRs are
not accepted by this initial configuration. The workflow rejects very large
diffs; split them into reviewable changes. If the PR head changes while Opus
is reviewing, no findings are posted: run the review again for the new commit.

## Review scope and decisions

Opus checks changed code for concrete regressions: history retention,
lost/duplicate delivery, reconnect/stop behavior, notification/location consent,
credentials, and release contents. Findings should identify the changed file,
line, triggering condition, and practical impact. Preferences and speculative
causes are not bugs by themselves.

The reviewer reads the diff and base code with read-only tools. It cannot run
tests, execute PR code, or confirm a physical-device experience. The maintainer
checks each finding, fixes verified problems, and records why any disputed
finding is not adopted. An empty report is not proof of correctness.

If authentication fails or the execution limit is reached, inspect the failed
run rather than interpreting the absence of comments as a successful review.
Update an expired secret through the same official authentication flow. There
is no automatic retry or model fallback.
