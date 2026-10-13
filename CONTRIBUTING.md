# Contributing to Dot Link

Bug reports, questions and ideas are welcome. Open an issue even if you do not
yet know the cause or have a patch. Describe what happened, what you expected,
and the version you used when available. Keep credentials and private
conversations out of reports.

dotsweeper reviews new issues and ready-for-review PRs, including external
contributions. Review prose follows your language, with English as the fallback.
It helps identify relevant code, missing information and next
steps. After updating your issue or PR, post `/dotlink review` to request another
review. The bot updates the same comment; use its run link if it reports a
failure. See [review behavior and limits](docs/ai-review.md).

For PRs, explain the problem, the resulting behavior and how you checked it.
Target `main`; use a draft while work is in progress. Distinguish automated tests,
code inspection and observations on a real Mac or Even G2. AI review is advisory;
maintainers decide adoption and merging.

Changes to `main` go through a PR with the existing `test` check passing and
the branch up to date. Force pushes and deletion of `main` are disabled,
including for administrators. A separate approving reviewer is not required;
dotsweeper review is not a required merge check.
