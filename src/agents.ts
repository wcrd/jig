// Recognises AI coding agents among commit authors, and their icons.

import {
  siAmp,
  siClaude,
  siCline,
  siCursor,
  siDeepseek,
  siGithubcopilot,
  siGitlab,
  siGoogle,
  siGooglegemini,
  siHuggingface,
  siJetbrains,
  siKimi,
  siMetaai,
  siMinimax,
  siMistralai,
  siOllama,
  siOpenrouter,
  siPerplexity,
  siQwen,
  siReplit,
  siV0,
  siWarp,
  siWindsurf,
} from "simple-icons";

import { avatarHue, escapeHtml, initials } from "./format";

interface Agent {
  name: string;
  /** SVG path on a 24×24 grid. */
  path: string;
  /** Brand colour; `null` uses the text colour (for black logos). */
  color: string | null;
  matches(name: string, email: string): boolean;
}

/** A generic sparkle, for agents without a recognisable logo. */
const SPARKLE =
  "M12 1.5c.5 4.9 2.6 7.5 9 10.5-6.4 3-8.5 5.6-9 10.5-.5-4.9-2.6-7.5-9-10.5 6.4-3 8.5-5.6 9-10.5z";

const AGENTS: Agent[] = [
  {
    name: "Claude",
    path: siClaude.path,
    color: `#${siClaude.hex}`,
    matches: (n, e) => /@anthropic\.com$/.test(e) || /^claude\b/i.test(n),
  },
  {
    name: "GitHub Copilot",
    path: siGithubcopilot.path,
    color: null,
    matches: (n, e) => /copilot/i.test(n) || /copilot.*@users\.noreply\.github\.com$/.test(e),
  },
  {
    name: "Gemini",
    path: siGooglegemini.path,
    color: `#${siGooglegemini.hex}`,
    matches: (n) => /\bgemini\b/i.test(n),
  },
  {
    name: "Cursor",
    path: siCursor.path,
    color: null,
    matches: (n, e) => /^cursor\b/i.test(n) || /@cursor\.(com|sh)$/.test(e),
  },
  {
    name: "Windsurf",
    path: siWindsurf.path,
    color: null,
    matches: (n, e) => /windsurf|codeium/i.test(n) || /@(codeium|windsurf)\.com$/.test(e),
  },
  {
    name: "Mistral",
    path: siMistralai.path,
    color: `#${siMistralai.hex}`,
    matches: (n, e) => /\b(mistral|devstral|codestral)\b/i.test(n) || /@mistral\.ai$/.test(e),
  },
  {
    name: "Perplexity",
    path: siPerplexity.path,
    color: `#${siPerplexity.hex}`,
    matches: (n) => /perplexity/i.test(n),
  },
  {
    name: "Ollama",
    path: siOllama.path,
    color: null,
    matches: (n) => /ollama/i.test(n),
  },
  {
    name: "DeepSeek",
    path: siDeepseek.path,
    color: `#${siDeepseek.hex}`,
    matches: (n, e) => /deepseek/i.test(n) || /@deepseek\.com$/.test(e),
  },
  {
    name: "Qwen",
    path: siQwen.path,
    color: `#${siQwen.hex}`,
    matches: (n, e) => /\bqwen/i.test(n) || /@(alibaba-inc|aliyun)\.com$/.test(e),
  },
  {
    name: "Kimi",
    path: siKimi.path,
    color: null,
    matches: (n, e) => /\b(kimi|moonshot)\b/i.test(n) || /@moonshot\.(ai|cn)$/.test(e),
  },
  {
    name: "MiniMax",
    path: siMinimax.path,
    color: `#${siMinimax.hex}`,
    matches: (n) => /\bminimax\b/i.test(n),
  },
  {
    name: "Meta AI",
    path: siMetaai.path,
    color: `#${siMetaai.hex}`,
    matches: (n) => /\b(llama|meta ai)\b/i.test(n),
  },
  {
    name: "Jules",
    path: siGoogle.path,
    color: `#${siGoogle.hex}`,
    matches: (n, e) => /^jules\b/i.test(n) || /jules.*@google\.com$/.test(e),
  },
  {
    name: "Junie",
    path: siJetbrains.path,
    color: null,
    matches: (n, e) => /\bjunie\b/i.test(n) || /junie.*@jetbrains\.com$/.test(e),
  },
  {
    name: "Replit Agent",
    path: siReplit.path,
    color: `#${siReplit.hex}`,
    matches: (n, e) => /replit/i.test(n) || /@replit\.com$/.test(e),
  },
  {
    name: "Amp",
    path: siAmp.path,
    color: `#${siAmp.hex}`,
    matches: (n, e) => /^amp\b/i.test(n) || /@(ampcode|sourcegraph)\.com$/.test(e),
  },
  {
    name: "Cline",
    path: siCline.path,
    color: null,
    matches: (n, e) => /^cline\b/i.test(n) || /@cline\.bot$/.test(e),
  },
  {
    name: "Warp",
    path: siWarp.path,
    color: `#${siWarp.hex}`,
    matches: (n, e) => /^warp\b/i.test(n) || /@warp\.dev$/.test(e),
  },
  {
    name: "v0",
    path: siV0.path,
    color: null,
    matches: (n, e) => /^v0\b/i.test(n) || /v0.*@vercel\.com$/.test(e),
  },
  {
    name: "GitLab Duo",
    path: siGitlab.path,
    color: `#${siGitlab.hex}`,
    matches: (n) => /gitlab duo/i.test(n),
  },
  {
    name: "Hugging Face",
    path: siHuggingface.path,
    color: `#${siHuggingface.hex}`,
    matches: (n) => /hugging ?face/i.test(n),
  },
  {
    name: "OpenRouter",
    path: siOpenrouter.path,
    color: `#${siOpenrouter.hex}`,
    matches: (n) => /openrouter/i.test(n),
  },
  {
    // OpenAI's logo isn't in simple-icons (removed at their request), so
    // Codex and ChatGPT get the sparkle, as do other agents recognised by name.
    name: "AI",
    path: SPARKLE,
    color: "#10a37f",
    matches: (n, e) =>
      /@openai\.com$/.test(e) || /\b(codex|chatgpt|gpt-\d|openai|devin|aider|opencode|goose|augment|tabnine|cody)\b/i.test(n),
  },
];

export function agentFor(name: string, email: string): Agent | null {
  return AGENTS.find((agent) => agent.matches(name, email.toLowerCase())) ?? null;
}

/**
 * An avatar for a person: their initials on a colour, or for an AI agent its
 * logo. `size` is the CSS class for the size variant.
 */
export function avatarHtml(name: string, email: string, size = ""): string {
  const agent = agentFor(name, email);
  const title = escapeHtml(email ? `${name} <${email}>` : name);
  if (agent) {
    const color = agent.color ? ` style="color:${agent.color}"` : "";
    return `<span class="avatar agent ${size}"${color} title="${title}"><svg viewBox="0 0 24 24"><path d="${agent.path}" fill="currentColor"/></svg></span>`;
  }
  return `<span class="avatar ${size}" style="--hue:${avatarHue(email || name)}" title="${title}">${escapeHtml(initials(name))}</span>`;
}

/** A small badge marking an AI agent, for the details panel. */
export function agentBadge(name: string, email: string): string {
  const agent = agentFor(name, email);
  return agent ? `<span class="agent-badge">AI</span>` : "";
}

/** A small agent logo for the corner of another avatar. */
export function agentCornerHtml(name: string, email: string): string {
  const agent = agentFor(name, email);
  if (!agent) return "";
  const color = agent.color ? ` style="color:${agent.color}"` : "";
  return `<span class="agent-corner"${color}><svg viewBox="0 0 24 24"><path d="${agent.path}" fill="currentColor"/></svg></span>`;
}
