# Bedrock Pull Request Review GitHub Action

Generate actionable pull request reviews with AWS Bedrock models (for example Claude 3 Sonnet). The action gathers PR metadata and diffs, sends them to the selected model, and publishes the response as an output you can reuse in follow-up steps (e.g., auto-comment, Slack, etc.).

## Requirements

- Runs on pull request events (`pull_request`, `pull_request_target`, or workflow call with PR context).
- A GitHub token with read access to the repository (defaults to `secrets.GITHUB_TOKEN`).
- AWS credentials with permission to invoke the selected Bedrock model (`bedrock:InvokeModel`). You can configure them with [`aws-actions/configure-aws-credentials`](https://github.com/aws-actions/configure-aws-credentials).

## Basic Usage

```yaml
name: PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  bedrock-review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
    steps:
      - uses: actions/checkout@v4
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::<account-id>:role/<bedrock-invoke-role>
          aws-region: ap-northeast-2

      - name: Generate review with Bedrock
        id: review
        uses: ./. # replace with the published action reference
        with:
          bedrock-region: ap-northeast-2
          bedrock-model-id: anthropic.claude-3-sonnet-20240229-v1:0
          review-instructions: |
            Focus on regressions and missing tests. Give high-level summary first.

      - name: Create PR comment
        if: steps.review.outputs.review != ''
        uses: peter-evans/create-or-update-comment@v4
        with:
          issue-number: ${{ github.event.pull_request.number }}
          body: ${{ steps.review.outputs.review }}
```

> ℹ️ Replace `uses: ./.` with the repository path once the action is published (e.g., `jun3453/bedrock-pr-review-action@v1`).

## Inputs

| Name | Required | Default | Description |
| ---- | -------- | ------- | ----------- |
| `github-token` | No | `secrets.GITHUB_TOKEN` | Token used for GitHub API calls. |
| `bedrock-region` | Yes | — | AWS region hosting the Bedrock endpoint. |
| `bedrock-model-id` | No | `anthropic.claude-3-sonnet-20240229-v1:0` | Bedrock model identifier. |
| `review-instructions` | No | — | Extra instructions for the reviewer agent. |
| `system-prompt` | No | Internal default | Override the system prompt sent to the model. |
| `max-diff-chars` | No | `60000` | Maximum diff characters forwarded to the model. |
| `max-model-tokens` | No | `2500` | Maximum tokens to request from the model response. |
| `include-review-summary` | No | `true` | Whether to render a summary in the GitHub Actions job summary. |

## Outputs

| Name | Description |
| ---- | ----------- |
| `review` | The textual review returned by the model. |
| `model-response-json` | Full JSON body from the Bedrock invocation (useful for debugging). |

## Notes

- Diffs larger than the configured budget are truncated per file to keep prompts within model limits.
- Binary files and files without textual patches are flagged in the prompt so the model knows they were changed.
- Rotate AWS credentials carefully and scope them to Bedrock invocation only.
