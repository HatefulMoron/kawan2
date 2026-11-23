import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { KawanDb } from "./db.js";
import type { InviteRow } from "./types.js";

const execFileAsync = promisify(execFile);

export const CHALLENGE_EXPIRY_SECONDS = 30;
export const INVITE_EXPIRY_MS = 24 * 60 * 60 * 1000;

export function ensureBootstrapToken(db: KawanDb): string | null {
  if (db.countHumans() > 0) {
    db.deleteSetting("bootstrap_token");
    return null;
  }
  const existing = db.getSetting("bootstrap_token");
  if (existing) return existing;
  const token = randomBytes(24).toString("hex");
  db.setSetting("bootstrap_token", token);
  return token;
}

export function validateSshPubkeyFormat(pubkey: string): string {
  const trimmed = pubkey.trim();
  if (!trimmed || trimmed.includes("\n") || trimmed.includes("\r")) {
    throw new Error("Invalid SSH public key: must be a single line");
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2 || !parts[0].startsWith("ssh-") && !parts[0].startsWith("ecdsa-") && !parts[0].startsWith("sk-")) {
    throw new Error("Invalid SSH public key format");
  }
  return trimmed;
}

export async function pubkeyFingerprint(pubkey: string): Promise<string> {
  const normalized = validateSshPubkeyFormat(pubkey);
  const dir = mkdtempSync(join(tmpdir(), "kawan-fp-"));
  try {
    const keyPath = join(dir, "key.pub");
    writeFileSync(keyPath, `${normalized}\n`, { mode: 0o600 });
    const { stdout } = await execFileAsync("ssh-keygen", ["-lf", keyPath], { timeout: 10_000 });
    const match = stdout.match(/(SHA256:[A-Za-z0-9+/=]+)/);
    if (!match) {
      throw new Error(`Unable to parse SSH key fingerprint from: ${stdout.trim()}`);
    }
    return match[1];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface IssuedChallenge {
  nonce: string;
  namespace: string;
  expires: number;
  expiresAt: number;
}

export function issueChallenge(hostNamespace: string): IssuedChallenge {
  const nonce = randomBytes(32).toString("base64");
  const expires = CHALLENGE_EXPIRY_SECONDS;
  return {
    nonce,
    namespace: `kawan@${hostNamespace}`,
    expires,
    expiresAt: Date.now() + expires * 1000,
  };
}

export async function verifyProofSignature(params: {
  principal: string;
  pubkey: string;
  namespace: string;
  nonce: string;
  signature: string;
}): Promise<boolean> {
  const cleanPrincipal = params.principal.replace(/\s+/g, "_");
  const cleanPubkey = validateSshPubkeyFormat(params.pubkey);
  if (!params.signature.includes("BEGIN SSH SIGNATURE")) {
    return false;
  }

  const dir = mkdtempSync(join(tmpdir(), "kawan-verify-"));
  try {
    const allowedPath = join(dir, "allowed_signers");
    const sigPath = join(dir, "proof.sig");
    writeFileSync(allowedPath, `${cleanPrincipal} ${cleanPubkey}\n`, { mode: 0o600 });
    writeFileSync(sigPath, params.signature, { mode: 0o600 });

    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        "ssh-keygen",
        [
          "-Y",
          "verify",
          "-f",
          allowedPath,
          "-I",
          cleanPrincipal,
          "-n",
          params.namespace,
          "-s",
          sigPath,
        ],
        { timeout: 10_000 },
        (error) => {
          if (error) reject(error);
          else resolve();
        },
      );
      child.stdin?.end(params.nonce, "utf8");
    });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function createInvite(db: KawanDb, createdBy: string, note: string | null = null): InviteRow {
  const token = randomBytes(24).toString("base64url");
  return db.createInvite(createdBy, token, note, Date.now() + INVITE_EXPIRY_MS);
}
