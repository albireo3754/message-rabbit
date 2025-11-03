import * as core from '@actions/core';
import * as github from '@actions/github';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const DEFAULT_MAX_DIFF_CHARS = 60000;
const DEFAULT_MODEL = 'anthropic.claude-3-sonnet-20240229-v1:0';

function readBooleanInput(name, defaultValue = false) {
  const raw = core.getInput(name);
  if (!raw) {
    return defaultValue;
  }
  return ['true', '1', 'yes'].includes(raw.toLowerCase());
}

function getInputs() {
  const explicitToken = core.getInput('github-token');
  const githubToken = explicitToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

  if (!githubToken) {
    throw new Error(
      'A GitHub token is required. Pass it via the github-token input or set the GITHUB_TOKEN environment variable.'
    );
  }

  return {
    githubToken,
    bedrockRegion: core.getInput('bedrock-region', { required: true }),
    bedrockModelId: core.getInput('bedrock-model-id') || DEFAULT_MODEL,
    maxDiffChars: parseInt(core.getInput('max-diff-chars') || `${DEFAULT_MAX_DIFF_CHARS}`, 10),
    reviewInstructions: core.getInput('review-instructions') || '',
    systemPrompt: core.getInput('system-prompt') || defaultSystemPrompt(),
    maxModelTokens: parseInt(core.getInput('max-model-tokens') || '2500', 10),
    includeReviewSummary: readBooleanInput('include-review-summary', true)
  };
}

function defaultSystemPrompt() {
  return [
    'You are an experienced senior software engineer tasked with reviewing GitHub pull requests.',
    'Provide actionable feedback focusing on correctness, security, and maintainability.',
    'Use concise bullet points. If everything looks good, explicitly say so.',
    'When you see issues, explain why they matter and suggest fixes.'
  ].join(' ');
}

function collectDiff(files, budget) {
  if (!Number.isFinite(budget) || budget <= 0) {
    return '';
  }

  let remaining = budget;
  const sections = [];

  for (const file of files) {
    const header = `# File: ${file.filename} (${file.status})`;
    const baseCost = header.length + 2;

    if (remaining <= baseCost) {
      break;
    }

    remaining -= baseCost;

    let body = file.patch || '';
    if (!body) {
      body = '[No textual diff available]';
    }

    if (body.length > remaining) {
      body = `${body.slice(0, Math.max(0, remaining - 20))}\n...diff truncated due to length limits...`;
    }

    sections.push(`${header}\n${body}`);
    remaining -= body.length;

    if (remaining <= 0) {
      break;
    }
  }

  return sections.join('\n\n');
}

function buildPrompt({ pr, diffText, instructions }) {
  const pieces = [
    `PR title: ${pr.title}`,
    `Author: ${pr.user?.login || 'unknown'}`,
    `Base: ${pr.base?.ref} @ ${pr.base?.sha}`,
    `Head: ${pr.head?.ref} @ ${pr.head?.sha}`,
    `Created at: ${pr.created_at}`
  ];

  if (pr.body) {
    pieces.push('\n## Pull Request Description\n', pr.body);
  }

  if (instructions) {
    pieces.push('\n## Additional Review Instructions\n', instructions);
  }

  pieces.push('\n## Diff\n', diffText || '[No diff available]');
  return pieces.join('\n');
}

function extractTextFromBedrockResponse(payload) {
  if (!payload) {
    return '';
  }

  if (payload.content && Array.isArray(payload.content)) {
    const textChunks = payload.content
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (item && typeof item === 'object') {
          return item.text || item.value || '';
        }
        return '';
      })
      .filter(Boolean);
    if (textChunks.length > 0) {
      return textChunks.join('\n');
    }
  }

  if (payload.output && typeof payload.output === 'object') {
    return extractTextFromBedrockResponse(payload.output);
  }

  if (payload.message && typeof payload.message === 'object') {
    return extractTextFromBedrockResponse(payload.message);
  }

  if (payload.result && typeof payload.result === 'object') {
    return extractTextFromBedrockResponse(payload.result);
  }

  if (payload.completion) {
    return payload.completion;
  }

  return '';
}

async function decodeResponseBody(body) {
  if (!body) {
    return '';
  }

  if (typeof body === 'string') {
    return body;
  }

  if (body instanceof Uint8Array) {
    const decoder = new TextDecoder();
    return decoder.decode(body);
  }

  if (typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    for await (const chunk of body) {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    }
    return chunks.join('');
  }

  if (Array.isArray(body)) {
    return body.map((chunk) => chunk.toString()).join('');
  }

  throw new Error('Unsupported response body type from Bedrock.');
}

async function callBedrock({ region, modelId, systemPrompt, prompt, maxTokens }) {
  const client = new BedrockRuntimeClient({ region });
  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: prompt
          }
        ]
      }
    ]
  };

  const command = new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(body)
  });

  const response = await client.send(command);
  const responseText = await decodeResponseBody(response.body);
  const parsed = JSON.parse(responseText);

  return {
    raw: parsed,
    text: extractTextFromBedrockResponse(parsed)
  };
}

async function fetchPullRequest({ octokit, context }) {
  const { pull_request: prPayload } = context.payload;
  if (!prPayload) {
    throw new Error('This action can only run on pull_request events.');
  }

  const { owner, repo } = context.repo;
  const pull_number = prPayload.number;

  const [pr, files] = await Promise.all([
    octokit.rest.pulls.get({ owner, repo, pull_number }).then((res) => res.data),
    octokit.paginate(octokit.rest.pulls.listFiles, { owner, repo, pull_number, per_page: 100 })
  ]);

  return { pr, files };
}

function formatSummary(text) {
  const lines = text.split('\n').map((line) => line.trim());
  const filtered = lines.filter((line) => line);
  return filtered.slice(0, 10).join('\n');
}

async function run() {
  try {
    const inputs = getInputs();
    const octokit = github.getOctokit(inputs.githubToken);
    const { pr, files } = await fetchPullRequest({ octokit, context: github.context });

    core.info(`Loaded PR #${pr.number} with ${files.length} file(s).`);

    const diffText = collectDiff(files, inputs.maxDiffChars);
    if (!diffText) {
      core.warning('No diff text included in prompt. The model may not have enough context.');
    }

    const prompt = buildPrompt({
      pr,
      diffText,
      instructions: inputs.reviewInstructions
    });

    const { text: review, raw } = await callBedrock({
      region: inputs.bedrockRegion,
      modelId: inputs.bedrockModelId,
      systemPrompt: inputs.systemPrompt,
      prompt,
      maxTokens: inputs.maxModelTokens
    });

    if (!review) {
      core.warning('Received empty response from Bedrock model.');
    }

    core.setOutput('review', review);
    core.setOutput('model-response-json', JSON.stringify(raw));

    if (inputs.includeReviewSummary && review) {
      const summary = formatSummary(review);
      await core.summary
        .addHeading(`Bedrock Review for PR #${pr.number}`)
        .addCodeBlock(summary)
        .write();
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

run();
