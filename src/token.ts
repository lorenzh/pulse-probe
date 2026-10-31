import { type Env, readString, StartupError } from "@lorenzh/pulse-kit";

const FILE_VAR = "PULSE_PROBE_TOKEN_FILE";
const FS_CODE = /^E[A-Z0-9]+$/;
// fetch rejects other header bytes and echoes the whole value in its error, which the client logs.
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

type TokenSource = { kind: "env"; token: string } | { kind: "file"; path: string };

/** Decides the token source from the env alone, before any file read. */
function tokenSource(env: Env): TokenSource {
  const token = readString(env, "PULSE_PROBE_TOKEN");
  const path = readString(env, FILE_VAR);
  if (token !== undefined && path !== undefined) {
    throw new StartupError("set only one of PULSE_PROBE_TOKEN and PULSE_PROBE_TOKEN_FILE");
  }
  if (token !== undefined) {
    if (!PRINTABLE_ASCII.test(token)) {
      throw new StartupError("PULSE_PROBE_TOKEN must hold printable ASCII");
    }
    return { kind: "env", token };
  }
  if (path !== undefined) return { kind: "file", path };
  throw new StartupError("PULSE_PROBE_TOKEN or PULSE_PROBE_TOKEN_FILE must be set");
}

function fsCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !Object.hasOwn(err, "code")) return undefined;
  const code: unknown = Object.getOwnPropertyDescriptor(err, "code")?.value;
  return typeof code === "string" && FS_CODE.test(code) ? code : undefined;
}

function readTokenFile(path: string, readFile: (path: string) => string): string {
  let content: string;
  try {
    content = readFile(path);
  } catch (err) {
    // Only the code: the raw fs message may carry more than the path.
    const code = fsCode(err);
    const suffix = code === undefined ? "" : ` (${code})`;
    throw new StartupError(`${FILE_VAR}=${path}: cannot read${suffix}`, { cause: err });
  }
  const token = content.trim();
  if (token === "") throw new StartupError(`${FILE_VAR}=${path}: file is empty`);
  if (/[\r\n]/.test(token)) throw new StartupError(`${FILE_VAR}=${path}: must hold one line`);
  if (!PRINTABLE_ASCII.test(token)) {
    throw new StartupError(`${FILE_VAR}=${path}: must hold printable ASCII`);
  }
  return token;
}

/**
 * Reads the probe token from PULSE_PROBE_TOKEN or the file named by PULSE_PROBE_TOKEN_FILE.
 * Exactly one must be set; blank counts as unset. Messages never hold the token or file content.
 */
export function readProbeToken(env: Env, readFile: (path: string) => string): string {
  const source = tokenSource(env);
  return source.kind === "env" ? source.token : readTokenFile(source.path, readFile);
}
