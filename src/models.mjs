// Which models a given install can actually run.
//
// The question an agent needs answered before delegating is not "what models
// exist" but "what slug will this binary accept". Those differ: on the machine
// this was built against, the Codex CLI on PATH accepts four models while the
// build inside the VS Code extension accepts five, and the extra one -
// gpt-6-astra - is the model the user's config.toml selects. Spawning the CLI
// with it fails.
//
// So every answer carries the install it came from and how it was obtained:
//
//   declared  the binary was asked and answered
//   inferred  strings were read out of the binary, which is a strong signal
//             and not a contract
//
// A caller that gets "inferred" should be ready for a spawn to fail anyway.

import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";

import * as cache from "./cache.mjs";
import { fingerprint } from "./installs.mjs";

const IS_WINDOWS = process.platform === "win32";

/** What to actually execute: the launcher when there is one, else the program. */
const invocable = (install) => install.launcher ?? install.path;

// ------------------------------------------------------------------- codex

/**
 * Codex documents its own protocol (`codex app-server generate-json-schema`)
 * and answers `model/list` over stdio. The most honest source of the three.
 */
function codexModels(binary, timeoutMs = 45000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, ["app-server"], { windowsHide: true });
    } catch (error) {
      return resolve({ error: String(error?.message ?? error) });
    }

    let buffer = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* already gone */ }
      resolve(value);
    };
    const send = (message) => {
      try { child.stdin.write(JSON.stringify(message) + "\n"); } catch { /* closed */ }
    };

    child.on("error", (error) => finish({ error: String(error?.message ?? error) }));
    setTimeout(() => finish({ error: `no answer within ${timeoutMs / 1000}s` }), timeoutMs).unref?.();

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;

        let message;
        try { message = JSON.parse(line); } catch { continue; }

        if (message.id === 1) {
          // The handshake needs the notification before anything else is served.
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          send({ id: 2, method: "model/list", params: { includeHidden: false } });
        }
        if (message.id === 2) {
          if (message.error) return finish({ error: JSON.stringify(message.error).slice(0, 200) });
          // The payload is under `data`; reading `models` returned zero from a
          // response that carried five.
          const items = message.result?.data ?? [];
          finish({
            models: items.map((m) => ({
              id: m.id ?? m.model,
              displayName: m.displayName ?? null,
              description: m.description ?? null,
              hidden: Boolean(m.hidden),
              reasoningEfforts: (m.supportedReasoningEfforts ?? [])
                .map((e) => e.reasoningEffort ?? e.effort)
                .filter(Boolean),
            })).filter((m) => m.id),
          });
        }
      }
    });

    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "agent-runway", version: "0.1.0", title: "agent-runway" } },
    });
  });
}

// ------------------------------------------------------------------ copilot

/**
 * The Copilot CLI has no list command, but its shell completion enumerates the
 * values `--model` accepts, which is the same thing said differently.
 */
function copilotModels(binary, timeoutMs = 30000) {
  const result = IS_WINDOWS
    ? spawnSync(`"${binary}" completion bash`, { encoding: "utf-8", windowsHide: true, timeout: timeoutMs, shell: true })
    : spawnSync(binary, ["completion", "bash"], { encoding: "utf-8", windowsHide: true, timeout: timeoutMs });

  if (result.error) return { error: String(result.error.message) };
  if (result.status !== 0) return { error: `completion exited ${result.status}` };

  const slugs = new Set(
    (result.stdout ?? "").match(/gpt-[0-9][0-9a-z.-]*|claude-[a-z0-9.-]+|gemini-[a-z0-9.-]+|grok-[a-z0-9.-]+/gi) ?? []
  );
  return { models: [...slugs].sort().map((id) => ({ id, displayName: null, hidden: false, reasoningEfforts: [] })) };
}

// ------------------------------------------------------------------- claude

// Noise the scan below picks up: documentation filenames and alias spellings
// that are not slugs anyone can pass to --model.
const CLAUDE_NOISE = /\.(md|txt|json)$|^\S+\.\d+$/;

/**
 * Claude Code exposes no list, so this reads identifiers out of the binary.
 * Strong evidence, not a contract: an absent string very likely means the build
 * does not know that model, but the CLI may still forward an arbitrary slug.
 */
async function claudeModels(binary) {
  const pattern = /claude-(?:opus|sonnet|haiku|fable)-[0-9][0-9a-z.-]{0,18}/g;
  const found = new Set();
  let tail = "";
  try {
    for await (const chunk of fs.createReadStream(binary, { highWaterMark: 8 << 20 })) {
      const text = tail + chunk.toString("latin1");
      for (const match of text.matchAll(pattern)) found.add(match[0]);
      tail = text.slice(-120);
    }
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }

  return {
    models: [...found]
      .filter((id) => !CLAUDE_NOISE.test(id))
      .sort()
      .map((id) => ({ id, displayName: null, hidden: false, reasoningEfforts: [] })),
  };
}

// --------------------------------------------------------------------- api

const READERS = {
  codex: { authority: "declared", read: (install) => codexModels(install.path) },
  copilot: { authority: "declared", read: (install) => copilotModels(invocable(install)) },
  claude: { authority: "inferred", read: (install) => claudeModels(install.path) },
};

/** Agents that can be spawned with a model argument. An IDE is not one. */
export const SPAWNABLE = Object.keys(READERS);

/**
 * @returns {Promise<{agent, kind, version, path, authority, models, error, cached}>}
 */
export async function modelsFor(install, { useCache = true } = {}) {
  const reader = READERS[install.agent];
  const base = {
    agent: install.agent,
    kind: install.kind,
    version: install.version,
    path: install.path,
    authority: reader?.authority ?? null,
  };

  if (!reader) return { ...base, models: [], error: "no model source for this agent" };

  // Keyed on the binary, not on a duration: the answer changes when the file
  // does, whether that is a CLI upgrade or a new extension build. Scanning a
  // 337MB binary is seconds of work that never needs repeating otherwise.
  const fp = install.fingerprint ?? fingerprint(install.path);
  const key = fp ? `models-${install.agent}-${fp}` : null;

  if (useCache && key) {
    const hit = cache.read(key, Infinity, Infinity);
    if (hit) return { ...base, ...hit.value, cached: true };
  }

  const outcome = await reader.read(install);
  const value = { models: outcome.models ?? [], error: outcome.error ?? null };
  // Errors are transient - an IDE mid-update, a locked file - so only a real
  // answer is worth remembering.
  if (key && !value.error && value.models.length) cache.write(key, value);

  return { ...base, ...value, cached: false };
}

/** Read several installs at once; one failing never costs the others. */
export async function modelsForAll(installs, options) {
  return Promise.all(
    installs
      .filter((i) => READERS[i.agent])
      .map((i) => modelsFor(i, options).catch((error) => ({
        agent: i.agent, kind: i.kind, version: i.version, path: i.path,
        models: [], error: String(error?.message ?? error),
      })))
  );
}

/** Which of these installs will accept a given slug. */
export function whoCanRun(slug, catalogues) {
  return catalogues.filter((c) => c.models.some((m) => m.id === slug));
}

/**
 * Installs that know about a model their sibling does not.
 *
 * This is the failure that motivated the module: a model offered by the build
 * behind an editor, absent from the one a delegation would spawn.
 */
export function modelSkew(catalogues) {
  const byAgent = new Map();
  for (const c of catalogues) {
    if (!byAgent.has(c.agent)) byAgent.set(c.agent, []);
    byAgent.get(c.agent).push(c);
  }

  const skews = [];
  for (const [agent, list] of byAgent) {
    const usable = list.filter((c) => !c.error && c.models.length);
    if (usable.length < 2) continue;

    const union = new Set(usable.flatMap((c) => c.models.map((m) => m.id)));
    for (const c of usable) {
      const missing = [...union].filter((id) => !c.models.some((m) => m.id === id));
      if (missing.length) skews.push({ agent, install: c, missing });
    }
  }
  return skews;
}
