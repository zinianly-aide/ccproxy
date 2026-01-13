import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

type EnvLine = {
  raw: string;
  key?: string;
  value?: string;
};

type FieldType = "text" | "number" | "bool" | "select" | "json";

type Field = {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
  mask?: boolean;
  allowGenerate?: boolean;
};

type Section = {
  title: string;
  defaultEnabled: boolean;
  fields: Field[];
};

const SECRET_KEYS = new Set([
  "LANAI_API_KEY",
  "CODEX_API_KEY",
  "DIFY_API_KEY",
  "ANTHROPIC_API_KEY"
]);

function isSecret(key: string, mask?: boolean): boolean {
  if (mask === false) return false;
  return SECRET_KEYS.has(key) || key.includes("SECRET") || key.includes("TOKEN");
}

function displayValue(key: string, value: string | undefined, mask?: boolean): string {
  if (value === undefined) return "unset";
  if (value === "") return "empty";
  if (isSecret(key, mask)) return "********";
  return value;
}

function parseEnvFile(text: string): { lines: EnvLine[]; values: Map<string, string> } {
  const lines = text.split(/\r?\n/);
  const parsed: EnvLine[] = [];
  const values = new Map<string, string>();

  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (match) {
      const key = match[1];
      const value = match[2] ?? "";
      parsed.push({ raw: line, key, value });
      values.set(key, value);
    } else {
      parsed.push({ raw: line });
    }
  }

  return { lines: parsed, values };
}

function applyEnvUpdates(lines: EnvLine[], updates: Map<string, string>): string {
  const used = new Set<string>();
  const outputLines = lines.map((line) => {
    if (!line.key) return line.raw;
    if (!updates.has(line.key)) return line.raw;
    used.add(line.key);
    const value = updates.get(line.key) ?? "";
    return `${line.key}=${value}`;
  });

  for (const [key, value] of updates.entries()) {
    if (used.has(key)) continue;
    outputLines.push(`${key}=${value}`);
  }

  return outputLines.join("\n").replace(/\n{3,}/g, "\n\n");
}

async function promptYesNo(
  rl: readline.Interface,
  question: string,
  defaultYes: boolean
): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  while (true) {
    const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
    if (!answer) return defaultYes;
    if (["y", "yes"].includes(answer)) return true;
    if (["n", "no"].includes(answer)) return false;
    console.log("Please enter y or n.");
  }
}

function generateKey(): string {
  return randomBytes(32).toString("hex");
}

async function promptText(
  rl: readline.Interface,
  field: Field,
  current: string | undefined
): Promise<string | undefined> {
  const hint = displayValue(field.key, current, field.mask);
  const genHint = field.allowGenerate ? " Type 'gen' to generate." : "";
  const answer = (await rl.question(
    `${field.label} (current: ${hint}). Enter to keep, '-' to clear.${genHint} `
  )).trim();

  if (!answer) return undefined;
  if (answer === "-" || answer.toLowerCase() === "clear") return "";
  if (field.allowGenerate && answer.toLowerCase() === "gen") {
    return generateKey();
  }
  return answer;
}

async function promptNumber(
  rl: readline.Interface,
  field: Field,
  current: string | undefined
): Promise<string | undefined> {
  const hint = displayValue(field.key, current, field.mask);
  while (true) {
    const answer = (await rl.question(
      `${field.label} (current: ${hint}). Enter to keep, '-' to clear. `
    )).trim();
    if (!answer) return undefined;
    if (answer === "-" || answer.toLowerCase() === "clear") return "";
    const value = Number(answer);
    if (!Number.isFinite(value)) {
      console.log("Please enter a valid number.");
      continue;
    }
    return String(value);
  }
}

async function promptBool(
  rl: readline.Interface,
  field: Field,
  current: string | undefined
): Promise<string | undefined> {
  const normalized = current?.trim().toLowerCase();
  const currentBool = normalized === "true" || normalized === "1" || normalized === "yes";
  const suffix = current === undefined ? "[y/N]" : currentBool ? "[Y/n]" : "[y/N]";
  while (true) {
    const answer = (await rl.question(`${field.label} ${suffix} `)).trim().toLowerCase();
    if (!answer) {
      if (current === undefined) return undefined;
      return currentBool ? "true" : "false";
    }
    if (["y", "yes", "true", "1"].includes(answer)) return "true";
    if (["n", "no", "false", "0"].includes(answer)) return "false";
    console.log("Please enter y or n.");
  }
}

async function promptSelect(
  rl: readline.Interface,
  field: Field,
  current: string | undefined
): Promise<string | undefined> {
  const options = field.options ?? [];
  const hint = displayValue(field.key, current, field.mask);
  if (!options.length) {
    return promptText(rl, field, current);
  }

  console.log(`${field.label} options:`);
  options.forEach((opt, idx) => {
    console.log(`  ${idx + 1}) ${opt}`);
  });

  while (true) {
    const answer = (await rl.question(
      `Select (current: ${hint}). Enter to keep, '-' to clear. `
    )).trim();
    if (!answer) return undefined;
    if (answer === "-" || answer.toLowerCase() === "clear") return "";
    const index = Number(answer);
    if (Number.isFinite(index) && index >= 1 && index <= options.length) {
      return options[index - 1];
    }
    const match = options.find((opt) => opt.toLowerCase() === answer.toLowerCase());
    if (match) return match;
    console.log("Please enter a valid option.");
  }
}

async function promptJson(
  rl: readline.Interface,
  field: Field,
  current: string | undefined
): Promise<string | undefined> {
  const hint = displayValue(field.key, current, field.mask);
  while (true) {
    const answer = (await rl.question(
      `${field.label} (current: ${hint}). Enter to keep, '-' to clear. `
    )).trim();
    if (!answer) return undefined;
    if (answer === "-" || answer.toLowerCase() === "clear") return "";
    try {
      const parsed = JSON.parse(answer);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        console.log("Please enter a JSON object.");
        continue;
      }
      return answer;
    } catch {
      console.log("Invalid JSON. Example: {\"key\":\"value\"}");
    }
  }
}

async function promptField(
  rl: readline.Interface,
  field: Field,
  current: string | undefined
): Promise<string | undefined> {
  switch (field.type) {
    case "number":
      return promptNumber(rl, field, current);
    case "bool":
      return promptBool(rl, field, current);
    case "select":
      return promptSelect(rl, field, current);
    case "json":
      return promptJson(rl, field, current);
    case "text":
    default:
      return promptText(rl, field, current);
  }
}

function updateDifyModel(
  modelsPath: string,
  alias: string,
  modelValue: string
): { action: "added" | "updated" } {
  const raw = fs.readFileSync(modelsPath, "utf8");
  const lines = raw.split(/\r?\n/);

  if (!lines.some((line) => line.trim() === "models:")) {
    throw new Error("configs/models.yaml is missing a top-level 'models:' key.");
  }

  let listIndent = "  ";
  let startIndex = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^(\s*)-\s+id:\s*(.+)\s*$/);
    if (!match) continue;
    if (match[1] !== undefined) listIndent = match[1] || listIndent;
    if (match[2].trim() === alias.trim()) {
      startIndex = i;
      listIndent = match[1] || listIndent;
      break;
    }
  }

  const propIndent = `${listIndent}  `;
  const providerLine = `${propIndent}provider: dify`;
  const modelLine = `${propIndent}model: ${modelValue}`;

  if (startIndex !== -1) {
    let endIndex = lines.length;
    for (let i = startIndex + 1; i < lines.length; i += 1) {
      if (lines[i].match(/^(\s*)-\s+id:\s*/)) {
        endIndex = i;
        break;
      }
    }

    const block = lines.slice(startIndex, endIndex);
    let foundProvider = false;
    let foundModel = false;
    const updatedBlock = block.map((line) => {
      if (line.trimStart().startsWith("provider:")) {
        foundProvider = true;
        return providerLine;
      }
      if (line.trimStart().startsWith("model:")) {
        foundModel = true;
        return modelLine;
      }
      return line;
    });

    if (!foundProvider) {
      updatedBlock.splice(1, 0, providerLine);
    }
    if (!foundModel) {
      const providerPos = updatedBlock.findIndex((line) =>
        line.trimStart().startsWith("provider:")
      );
      const insertPos = providerPos >= 0 ? providerPos + 1 : 1;
      updatedBlock.splice(insertPos, 0, modelLine);
    }

    lines.splice(startIndex, endIndex - startIndex, ...updatedBlock);
    fs.writeFileSync(modelsPath, lines.join("\n"));
    return { action: "updated" };
  }

  const newEntry = [
    `${listIndent}- id: ${alias}`,
    providerLine,
    modelLine
  ];
  lines.push("");
  lines.push(...newEntry);
  fs.writeFileSync(modelsPath, lines.join("\n"));
  return { action: "added" };
}

async function main() {
  const repoRoot = process.cwd();
  const envPath = path.join(repoRoot, ".env");
  const envExamplePath = path.join(repoRoot, ".env.example");
  const modelsPath = path.join(repoRoot, "configs", "models.yaml");

  if (!fs.existsSync(modelsPath)) {
    console.error("configs/models.yaml not found. Run this from the repo root.");
    process.exit(1);
  }

  if (!fs.existsSync(envPath)) {
    if (fs.existsSync(envExamplePath)) {
      fs.copyFileSync(envExamplePath, envPath);
    } else {
      fs.writeFileSync(envPath, "");
    }
  }

  const { lines, values } = parseEnvFile(fs.readFileSync(envPath, "utf8"));
  const updates = new Map<string, string>();

  const rl = readline.createInterface({ input, output });
  process.on("SIGINT", () => {
    rl.close();
    process.exit(0);
  });

  console.log("LANAI Proxy Config TUI");
  console.log("----------------------");

  const sections: Section[] = [
    {
      title: "Core security",
      defaultEnabled: true,
      fields: [
        { key: "LANAI_API_KEY", label: "LANAI API key", type: "text", allowGenerate: true },
        { key: "LAN_ALLOW_CIDRS", label: "Allowed CIDRs", type: "text" },
        { key: "RATE_LIMIT_PER_MIN", label: "Rate limit per minute", type: "number" },
        { key: "CORS_ALLOW_ORIGINS", label: "CORS allow origins", type: "text" }
      ]
    },
    {
      title: "Network & paths",
      defaultEnabled: true,
      fields: [
        { key: "REPO_ROOT", label: "Repo root", type: "text" },
        { key: "PROXY_HOST", label: "Proxy host", type: "text" },
        { key: "PROXY_PORT", label: "Proxy port", type: "number" },
        { key: "MCP_HTTP_HOST", label: "MCP HTTP host", type: "text" },
        { key: "MCP_HTTP_PORT", label: "MCP HTTP port", type: "number" },
        { key: "MCP_HTTP_BASE_URL", label: "MCP HTTP base URL", type: "text" },
        { key: "MODELS_CONFIG", label: "Models config path", type: "text" }
      ]
    },
    {
      title: "Ollama provider",
      defaultEnabled: false,
      fields: [{ key: "OLLAMA_URL", label: "Ollama base URL", type: "text" }]
    },
    {
      title: "Gemini provider",
      defaultEnabled: false,
      fields: [
        { key: "GEMINI_BIN", label: "Gemini CLI bin", type: "text" },
        { key: "GEMINI_ARGS", label: "Gemini CLI args", type: "text" }
      ]
    },
    {
      title: "Codex provider",
      defaultEnabled: false,
      fields: [
        {
          key: "CODEX_PROVIDER",
          label: "Codex provider type",
          type: "select",
          options: ["cli", "http"]
        },
        { key: "CODEX_BIN", label: "Codex bin", type: "text" },
        { key: "CODEX_ARGS", label: "Codex args", type: "text" },
        { key: "CODEX_API_KEY", label: "Codex API key", type: "text" },
        { key: "CODEX_BASE_URL", label: "Codex base URL", type: "text" },
        { key: "CODEX_CWD", label: "Codex working dir", type: "text" },
        {
          key: "CODEX_SANDBOX",
          label: "Codex sandbox",
          type: "select",
          options: ["read-only", "workspace-write", "danger-full-access"]
        },
        { key: "CODEX_FULL_AUTO", label: "Codex full auto", type: "bool" },
        { key: "CODEX_ALLOW_SEARCH", label: "Codex allow search", type: "bool" }
      ]
    },
    {
      title: "Dify provider",
      defaultEnabled: true,
      fields: [
        { key: "DIFY_BASE_URL", label: "Dify base URL", type: "text" },
        { key: "DIFY_API_KEY", label: "Dify API key", type: "text" },
        {
          key: "DIFY_API_MODE",
          label: "Dify API mode",
          type: "select",
          options: ["openai", "chat"]
        },
        {
          key: "DIFY_CONTEXT_MODE",
          label: "Dify context mode",
          type: "select",
          options: ["stateless", "stateful"]
        },
        { key: "DIFY_USER", label: "Dify user id", type: "text" },
        { key: "DIFY_CONVERSATION_ID", label: "Dify conversation id", type: "text" },
        { key: "DIFY_INPUTS_JSON", label: "Dify inputs JSON", type: "json" }
      ]
    },
    {
      title: "Anthropic provider",
      defaultEnabled: false,
      fields: [
        { key: "ANTHROPIC_API_KEY", label: "Anthropic API key", type: "text" },
        { key: "ANTHROPIC_BASE_URL", label: "Anthropic base URL", type: "text" }
      ]
    },
    {
      title: "Logging",
      defaultEnabled: false,
      fields: [
        {
          key: "LOG_LEVEL",
          label: "Log level",
          type: "select",
          options: ["trace", "debug", "info", "warn", "error", "fatal"]
        },
        { key: "LOG_STDERR", label: "Log to stderr", type: "bool" }
      ]
    }
  ];

  try {
    for (const section of sections) {
      const proceed = await promptYesNo(
        rl,
        `Configure ${section.title}?`,
        section.defaultEnabled
      );
      if (!proceed) continue;

      for (const field of section.fields) {
        const current = values.get(field.key);
        const next = await promptField(rl, field, current);
        if (next === undefined) continue;
        updates.set(field.key, next);
        values.set(field.key, next);
      }
    }

    const updateModels = await promptYesNo(
      rl,
      "Add/update a Dify model alias in configs/models.yaml?",
      false
    );
    if (updateModels) {
      const alias = (await rl.question("Model alias (example: dify:cc): ")).trim();
      if (!alias) {
        console.log("Skipping models.yaml update (alias empty).");
      } else {
        const modelValue = (await rl.question("Dify model/app id: ")).trim();
        if (!modelValue) {
          console.log("Skipping models.yaml update (model empty).");
        } else {
          const result = updateDifyModel(modelsPath, alias, modelValue);
          console.log(`models.yaml ${result.action}.`);
        }
      }
    }
  } finally {
    rl.close();
  }

  if (updates.size === 0) {
    console.log("No .env changes to save.");
    return;
  }

  const nextEnv = applyEnvUpdates(lines, updates);
  fs.writeFileSync(envPath, nextEnv.endsWith("\n") ? nextEnv : `${nextEnv}\n`);
  console.log(`Saved ${updates.size} setting(s) to .env.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
