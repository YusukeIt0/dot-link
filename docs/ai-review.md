# Opus issue and pull-request review

Dot Link welcomes rough bug reports, questions and ideas. You do not need to
write a patch before opening an issue. Opus helps clarify the report and suggest
next steps; maintainers decide what to adopt, close or merge.

## When review runs

- A new issue starts a review, including issues from external contributors.
- A non-draft PR targeting `main` starts a review, including fork PRs.
- Marking a draft PR ready starts its first review.
- Further pushes and ordinary comments do not automatically rerun Opus.
- The author or a maintainer with write access can request another review by
  posting this exact comment on the open issue or PR:

  ```text
  /opus review
  ```

The bot updates one comment to show reviewing, complete, outdated or failed.
If content or `main` changes during a review, its findings are withheld; request
another review after the changes settle. Actions concurrency serializes each
item; GitHub may replace an older pending request with a newer pending request.
If a workflow is manually cancelled, its last comment can remain in progress;
check the linked run and request another review.

A maintainer can also use **Actions → Opus Review → Run workflow**, selecting
`main` and entering an issue or PR number. Closed, locked and draft items are
not reviewed. Automated bot accounts do not trigger this workflow.

## What to expect

Review prose follows the original author's language, or their explicit language
request. English is the fallback when unclear. Shared status labels and command
help use English.

Issue review reads the description, human comments, current public code and
docs. It distinguishes evidence, possible causes, missing information and
product decisions. Related issues are not comprehensively searched in this
initial version; include relevant links and summarize their connection.

PR review reads the diff, discussion and base code for concrete regressions,
including history retention, lost/duplicate delivery, reconnect/stop behavior,
notification/location consent, credentials and release contents. Findings
identify a changed file, line, triggering condition and practical impact.
Preferences and speculative causes are not established bugs.

This is static review. Opus cannot run tests, execute contributor code, or
confirm physical-device behavior. A report with no findings is not proof of
correctness. Maintainers evaluate important findings and record why a disputed
finding is not adopted. Opus is not currently a required merge check and never
approves, merges, implements, labels or closes an item. Whether review completion
becomes mandatory is a future maintainer decision, informed by actual use.

Input limits are 150 KB of issue/PR text and human discussion, 250 KB of PR diff,
and 50 changed files. Oversized inputs produce an explicit incomplete status,
not a partial clean review. Each model job has a 15-minute timeout and 12-turn
limit. There is no automatic retry or model fallback. Failed authentication,
usage exhaustion or invalid results must not be interpreted as successful review.

## Authentication and security

Use the official `claude setup-token` flow with a Claude subscription and store
the token only as the repository Actions secret `CLAUDE_CODE_OAUTH_TOKEN`.
Never paste it into chat, an issue, a workflow or a committed file. The workflow
has no API-key fallback. Subscription limits and enabled extra usage still apply;
time and turn limits are not a monetary spending cap. Cloud-session promotional
credits are not assumed to cover Actions.

If a run reports an authentication failure, generate a fresh token through the
official flow and replace the Actions secret, then request another review.
A successful browser consent screen alone does not verify the stored secret;
confirm that the linked Actions run completes and publishes a review.

The workflow runs on GitHub-hosted runners with trusted default-branch scripts.
It never checks out or executes fork/PR-head code. The model job receives only
read permissions to GitHub and Read/Glob/Grep tools. Intake and publication are
separate jobs with issue/PR-comment write access and no Claude credential. They
validate the target, requester, input revision and structured output. Comments
cannot supply arbitrary prompts, commands or a model choice. Public issue/PR
content is sent to Anthropic for review, and results appear publicly on GitHub.
Do not submit secrets or private conversations in an issue or PR.

The pinned official Claude Code Action accepts a short-lived `github_token`;
this configuration does not require installing an additional GitHub App.
Its `allowed_non_write_users` input is enabled only for the read-only review job;
our intake first verifies the exact automatic event or author/maintainer command.
Repository writers can modify workflows, so write access remains a trusted role.

The review design draws on [OpenClaw's review flow](https://github.com/openclaw/openclaw/blob/main/docs/reference/pull-request-review-flow.md)
and [ClawSweeper](https://github.com/openclaw/clawsweeper): initial automatic
review, author-requested re-review, one durable comment, and separation of model
assessment from GitHub mutations. Dot Link uses its own Opus workflow and does
not use OpenClaw's hosted service.

## 日本語

不具合・疑問・アイデアは、実装前でも気軽にIssueへ投稿できます。
分かる範囲で、起きたこと・期待したこと・利用バージョンを書いてください。
Issue作成時とPRをレビュー可能にしたときに、外部投稿者も含め自動レビューします。
追記や修正後は、投稿者または管理者が `/opus review` とコメントすると再レビューを依頼できます。

結果は同じコメントを更新して表示します。レビュー中・完了・未完了・対象更新による
再レビューの必要を区別します。通常のコメントや追加pushだけでは再実行しません。
Opusは公開コードを読む参考レビューで、実機確認やテストを代替しません。
Issueの採用・クローズ、PRのマージは管理者が判断します。現在はマージの必須条件ではありません。
認証情報や私的な会話を投稿しないでください。公開投稿内容はレビューのためAnthropicへ送られます。
