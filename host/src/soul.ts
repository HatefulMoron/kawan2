import type { KawanDb } from "./db.js";
import type { SoulHandlers } from "./sessions.js";
import type { SessionRow } from "./types.js";

export const SOUL_CAP_BYTES = 4096;

export const REQUIRED_SOUL_HEADINGS = [
  "## Working agreements",
  "## Project facts",
  "## Decisions",
  "## Preferences",
] as const;

export const INITIAL_SOUL_DOCUMENT = `## Working agreements

- Keep changes focused, commit with clear messages, and verify before requesting land.

## Project facts

- Repository facts discovered during sessions go here.

## Decisions

- Key architectural choices and tradeoffs go here.

## Preferences

- Human communication and workflow preferences go here.
`;

function computeLineDiff(before: string, after: string): string {
  const aLines = before.split(/\r?\n/);
  const bLines = after.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  let j = 0;

  while (i < aLines.length || j < bLines.length) {
    if (i < aLines.length && j < bLines.length && aLines[i] === bLines[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (i < aLines.length && (j >= bLines.length || !bLines.slice(j, j + 5).includes(aLines[i]))) {
      out.push(`- ${aLines[i]}`);
      i += 1;
    } else if (j < bLines.length) {
      out.push(`+ ${bLines[j]}`);
      j += 1;
    }
  }
  return out.length > 0 ? out.join("\n") : "(no diff)";
}

function validateSoulSize(content: string): number {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > SOUL_CAP_BYTES) {
    throw new Error(
      `Soul document exceeds ${SOUL_CAP_BYTES}-byte cap (${bytes} bytes); consolidate existing notes before writing more.`,
    );
  }
  return bytes;
}

function validateRequiredHeadings(document: string): void {
  const lines = document.split(/\r?\n/).map((l) => l.trim());
  for (const heading of REQUIRED_SOUL_HEADINGS) {
    const count = lines.filter((l) => l === heading).length;
    if (count === 0) {
      throw new Error(`Missing required section heading '${heading}' in soul_write document`);
    }
    if (count > 1) {
      throw new Error(`Duplicate section heading '${heading}' (${count} occurrences) in soul_write document`);
    }
  }
}

export function replaceSoul(
  db: KawanDb,
  params: { botId: string; anchor: string; text: string; authorSessionId?: string | null },
): { revision: number; bytes: number; cap: number; summary: string } {
  const latest = db.getLatestSoul(params.botId);
  const current = latest?.content ?? INITIAL_SOUL_DOCUMENT;
  const anchor = params.anchor;
  if (!anchor) {
    throw new Error("soul_replace anchor cannot be empty");
  }

  const firstIdx = current.indexOf(anchor);
  if (firstIdx === -1) {
    throw new Error(`Anchor not found in soul document: ${JSON.stringify(anchor.slice(0, 80))}`);
  }
  const secondIdx = current.indexOf(anchor, firstIdx + 1);
  if (secondIdx !== -1) {
    throw new Error(
      `Ambiguous anchor matched multiple locations in soul document: ${JSON.stringify(anchor.slice(0, 80))}. Provide a more specific unique anchor.`,
    );
  }

  // Use slice concatenation rather than String.prototype.replace to avoid `$&`/`$1` interpolation bugs.
  const next = current.slice(0, firstIdx) + params.text + current.slice(firstIdx + anchor.length);
  const bytes = validateSoulSize(next);
  const diff = computeLineDiff(current, next);
  const nextRevision = (latest?.revision ?? 0) + 1;

  db.insertSoulRevision({
    botId: params.botId,
    revision: nextRevision,
    content: next,
    diff,
    authorSessionId: params.authorSessionId ?? null,
  });

  const action = params.text === "" ? "deleted anchor" : "replaced anchor";
  return {
    revision: nextRevision,
    bytes,
    cap: SOUL_CAP_BYTES,
    summary: `rev ${nextRevision}: ${action} (${bytes}/${SOUL_CAP_BYTES} bytes)`,
  };
}

export function writeSoul(
  db: KawanDb,
  params: { botId: string; document: string; authorSessionId?: string | null },
): { revision: number; bytes: number; cap: number; summary: string } {
  const latest = db.getLatestSoul(params.botId);
  const current = latest?.content ?? INITIAL_SOUL_DOCUMENT;
  validateRequiredHeadings(params.document);
  const bytes = validateSoulSize(params.document);
  const diff = computeLineDiff(current, params.document);
  const nextRevision = (latest?.revision ?? 0) + 1;

  db.insertSoulRevision({
    botId: params.botId,
    revision: nextRevision,
    content: params.document,
    diff,
    authorSessionId: params.authorSessionId ?? null,
  });

  const changedLines = diff === "(no diff)" ? 0 : diff.split("\n").length;
  return {
    revision: nextRevision,
    bytes,
    cap: SOUL_CAP_BYTES,
    summary: `rev ${nextRevision}: rewrote soul (${changedLines} changed lines, ${bytes}/${SOUL_CAP_BYTES} bytes)`,
  };
}

export function filterSoulForWorker(content: string): string {
  const sections = content.split(/(?=^##\s+)/m);
  const kept = sections.filter((sec) => {
    const firstLine = sec.split(/\r?\n/, 1)[0].trim().toLowerCase();
    return (
      firstLine === "## working agreements" ||
      firstLine === "## project facts"
    );
  });
  return kept.join("\n").trim();
}

export function formatLiveSessionsSummary(sessions: SessionRow[]): string {
  if (sessions.length === 0) {
    return "## Active & recent worker sessions\n\n(none)\n";
  }
  const lines = sessions.map((w) => {
    const label = w.title?.trim() || w.task?.split(/\r?\n/, 1)[0]?.slice(0, 48) || w.id.slice(0, 8);
    const reportSnippet = w.last_report ? w.last_report.replace(/\s+/g, " ").slice(0, 160) : "no report yet";
    return `- ${label} (session_id=${w.id}, status=${w.status}): ${reportSnippet}`;
  });
  return `## Active & recent worker sessions\n\n${lines.join("\n")}\n`;
}

export function createSoulHandlers(db: KawanDb): SoulHandlers {
  return {
    getContext(session: SessionRow) {
      const contextFiles: Array<{ path: string; content: string }> = [];
      if (session.kind === "orchestrator") {
        const latest = db.getLatestSoul(session.bot_id);
        contextFiles.push({
          path: "kawan://soul.md",
          content: latest?.content ?? INITIAL_SOUL_DOCUMENT,
        });
        const workers = db.listSessions({ botId: session.bot_id, kind: "worker" });
        contextFiles.push({
          path: "kawan://sessions.md",
          content: formatLiveSessionsSummary(workers),
        });
      } else if (session.soul_snapshot) {
        contextFiles.push({
          path: "kawan://soul.md",
          content: session.soul_snapshot,
        });
      }
      return { contextFiles };
    },

    soulReplace(session: SessionRow, params: { anchor: string; text: string }) {
      return replaceSoul(db, {
        botId: session.bot_id,
        anchor: params.anchor,
        text: params.text,
        authorSessionId: session.id,
      });
    },

    soulWrite(session: SessionRow, params: { document: string }) {
      return writeSoul(db, {
        botId: session.bot_id,
        document: params.document,
        authorSessionId: session.id,
      });
    },
  };
}
