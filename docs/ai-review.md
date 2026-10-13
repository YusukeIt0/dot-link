# dotsweeper issue and pull-request review

Dot Link welcomes rough bug reports, questions and ideas. You do not need to
write a patch before opening an issue. dotsweeper helps clarify the report and suggest
next steps; maintainers decide what to adopt, close or merge.

## When review runs

- A new issue starts a review, including issues from external contributors.
- A non-draft PR targeting `main` starts a review, including fork PRs.
- Marking a draft PR ready starts its first review.
- Further pushes and ordinary comments do not automatically rerun dotsweeper.
- The author or a maintainer with write access can request another review by
  posting this exact comment on the open issue or PR:

  ```text
  /dotlink review
  ```

The `dotsweeper` bot, using the Dot Link icon, updates one comment to show reviewing, complete, outdated or failed.
If content or `main` changes during a review, its findings are withheld; request
another review after the changes settle. Actions concurrency serializes each
item; GitHub may replace an older pending request with a newer pending request.
If a workflow is manually cancelled, its last comment can remain in progress;
check the linked run and request another review.

A maintainer can also use **Actions → dotsweeper review → Run workflow**, selecting
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

This is static review. dotsweeper cannot run tests, execute contributor code, or
confirm physical-device behavior. A report with no findings is not proof of
correctness. Maintainers evaluate important findings and record why a disputed
finding is not adopted. dotsweeper is not currently a required merge check and never
approves, merges, implements or closes an item. Issue labeling follows the bounded rules below. Whether review completion
becomes mandatory is a future maintainer decision, informed by actual use.

Input limits are 150 KB of issue/PR text and human discussion, 250 KB of PR diff,
and 50 changed files. Oversized inputs produce an explicit incomplete status,
not a partial clean review. Each model job has a 15-minute timeout and 12-turn
limit. There is no automatic retry or model fallback. Failed authentication,
usage exhaustion or invalid results must not be interpreted as successful review.

## Issue labels

Successful issue reviews propose a priority and up to eight classification labels,
with a reason for each. A separate publisher validates the result against
[the label catalog](../config/review-labels.json) and applies the allowed labels.
PR reviews do not change labels. Failed, invalid or outdated reviews do not change
labels. A label-write failure is reported separately from completed findings.

- `P0`: emergency; `P1`: high user impact or reliability risk; `P2`: normal backlog;
  `P3`: polish or a proposal whose scope is undecided. Priority is scheduling
  guidance, not the severity of an individual finding. Tracking indexes can have
  no single priority.
- Types/areas: `bug`, `enhancement`, `documentation`, `validation`, `ux`,
  `reliability`, `regression`, `tracking`. Regression requires concrete evidence
  that previously working behavior subsequently failed.
- Impact: `impact:ux-friction`, `impact:ux-release-blocker`.
- Investigation: `needs-info`, `needs-live-repro`, `needs-product-decision`.

Existing priority labels are always preserved, including an earlier bot priority.
To reconsider priority, remove the existing priority and request `/dotlink review`.
Removing a priority invites a new priority on any later authorized review, including
a review requested by the issue author. To deliberately keep an issue unprioritized,
add `triage:manual`. This priority rule differs from preserving removed categories.
The comment still shows the new proposal even when an existing priority is kept.
Categories are removed only if their latest label event belongs to the exact
verified dotsweeper bot. Human-added categories and unrelated labels are preserved;
a category removed by a human is not automatically re-added. Re-add it manually
if wanted. Add `triage:manual` to pause all automatic label changes for an issue;
remove that lock and request review to resume under the same preservation rules.
GitHub label operations are not atomic; partial failure is explicit and a later
review can reconcile the remaining bot-owned labels.

Existing open issues use the same workflow: request `/dotlink review` or dispatch
one review by issue number. Labels do not authorize implementation or release.
Maintainers can change them, and static review cannot establish live behavior.

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

The pinned official Claude Code Action uses the read-only workflow `github_token`.
A private GitHub App named `dotsweeper`, installed only on this public repository,
provides the posting identity and Dot Link avatar. Set repository variables
`DOTSWEEPER_CLIENT_ID` and `DOTSWEEPER_BOT_ID`, and store its private key only in
Actions secret `DOTSWEEPER_PRIVATE_KEY`. The official token action mints short-lived
Issue/PR write tokens only for intake and publication. The model job receives
neither this key nor these tokens. Existing `github-actions` comments remain as
history; the first dotsweeper run starts its own comment.
Its `allowed_non_write_users` input is enabled only for the read-only review job;
our intake first verifies the exact automatic event or author/maintainer command.
Repository writers can modify workflows, so write access remains a trusted role.

The review design draws on [OpenClaw's review flow](https://github.com/openclaw/openclaw/blob/main/docs/reference/pull-request-review-flow.md)
and [ClawSweeper](https://github.com/openclaw/clawsweeper): initial automatic
review, author-requested re-review, one durable comment, and separation of model
assessment from GitHub mutations. Dot Link uses its own dotsweeper workflow and does
not use OpenClaw's hosted service.

## 日本語

不具合・疑問・アイデアは、実装前でも気軽にIssueへ投稿できます。
分かる範囲で、起きたこと・期待したこと・利用バージョンを書いてください。
Issue作成時とPRをレビュー可能にしたときに、外部投稿者も含め自動レビューします。
追記や修正後は、投稿者または管理者が `/dotlink review` とコメントすると再レビューを依頼できます。

結果は同じコメントを更新して表示します。レビュー中・完了・未完了・対象更新による
再レビューの必要を区別します。通常のコメントや追加pushだけでは再実行しません。
dotsweeperは公開コードを読む参考レビューで、実機確認やテストを代替しません。
Issueには優先度・種類・影響・調査状態のラベルを理由付きで提案し、許可一覧の範囲だけ反映します。
Issueの採用・クローズ、PRのマージは管理者が判断します。現在はマージの必須条件ではありません。
認証情報や私的な会話を投稿しないでください。公開投稿内容はレビューのためAnthropicへ送られます。

既存の優先度はbotが付けたものも維持します。変更したい場合は優先度ラベルを外して
`/dotlink review`で再依頼してください。分類ラベルはbot自身が付けたものだけ更新し、
手動で付けた・外した判断を維持します。`triage:manual`で自動ラベル変更を止められます。
ラベルは実装・公開の承認ではありません。PRへの自動ラベル付与は行いません。

優先度を外すと、投稿者を含む権限のある人の次回レビュー依頼で再付与され得ます。
優先度なしを維持したい場合は`triage:manual`を付けてください。分類ラベルの手動除去とは扱いが異なります。
