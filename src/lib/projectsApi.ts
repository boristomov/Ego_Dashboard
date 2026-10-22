// Client for the project deliveries Worker (infra/projects).
//
// Inert without VITE_PROJECTS_ENDPOINT: the Data Browser then shows only the
// pilot dataset. Admins reuse the registry session token; a client account
// trades its password for this Worker's own token at dashboard sign-in
// (context/Auth.tsx), with the slow PBKDF2 half run here, as in registryApi.

import { registryToken } from "./registryApi";

type ViteEnv = { env?: { VITE_PROJECTS_ENDPOINT?: string } };
const ENV = (import.meta as unknown as ViteEnv).env ?? {};
const ENDPOINT = (ENV.VITE_PROJECTS_ENDPOINT || "").replace(/\/+$/, "");

export const PROJECTS_CONFIGURED = !!ENDPOINT;

const CLIENT_TOKEN_KEY = "ego_projects_token";

export class ProjectsApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type ProjectCheck = { id: string; ok: boolean; value?: unknown; limit?: string; note?: string };
export type ProjectFile = { name: string; label: string; bytes: number; sha256?: string | null };

/** One Wirestock clip (scripts/wirestock_publish.py, clip_entry). */
export type ProjectClip = {
  clip_id: string;
  session: string;
  station: string | null;
  task_name: string;
  task_as_recorded?: string | null;
  description?: string | null;
  task_category?: string | null;
  task_activity?: string | null;
  environment?: string | null;
  duration_s: number;
  start_time_utc: string;
  resolution: string;
  fps: number;
  device_model?: string;
  narration?: { language?: string; style?: string };
  checks_passed: boolean;
  checks: ProjectCheck[];
  capture_format?: string;
  prefix: string;
  /** The raw take, `<task>/<session>`; deletes need it. */
  raw_prefix?: string | null;
  preview?: string | null;
  thumb?: string | null;
  files: ProjectFile[];
};

/** One sample-data take (scripts/wirestock_publish.py, samples). */
export type SampleSession = {
  session: string;
  task_name: string;
  station: string | null;
  duration_s: number | null;
  resolution: string;
  fps: unknown;
  start_time_utc?: string | null;
  device_model?: string | null;
  quality_status?: string | null;
  label: string;
  prefix: string;
  raw_prefix?: string | null;
  preview?: string | null;
  thumb?: string | null;
  files: ProjectFile[];
};

export type ProjectIndex = {
  schema: string;
  project: string;
  title: string;
  subtitle?: string;
  updated_at: string;
  clips?: ProjectClip[];
  sessions?: SampleSession[];
};

export type ProjectDoc = { project: string; index: ProjectIndex; grant: string; grantExp: number; admin: boolean };

function clientToken(): string | null {
  try {
    return sessionStorage.getItem(CLIENT_TOKEN_KEY);
  } catch {
    return null;
  }
}

function bearer(): string | null {
  return clientToken() || registryToken();
}

export function hasProjectsSession(): boolean {
  return PROJECTS_CONFIGURED && !!bearer();
}

export function signOutProjects(): void {
  try {
    sessionStorage.removeItem(CLIENT_TOKEN_KEY);
  } catch {
    /* private browsing */
  }
}

async function req<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
  if (!ENDPOINT) throw new ProjectsApiError(0, "Project deliveries are not deployed");
  const headers: Record<string, string> = { ...((init.headers as Record<string, string>) || {}) };
  if (auth) {
    const t = bearer();
    if (!t) throw new ProjectsApiError(401, "Not signed in");
    headers.Authorization = `Bearer ${t}`;
  }
  let res: Response;
  try {
    res = await fetch(`${ENDPOINT}${path}`, { ...init, headers });
  } catch (e) {
    throw new ProjectsApiError(0, e instanceof Error ? e.message : "Project endpoint unreachable");
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* status message below */
  }
  if (!res.ok) {
    if (res.status === 401 && clientToken()) signOutProjects();
    throw new ProjectsApiError(res.status, (body as { error?: string })?.error || text || `HTTP ${res.status}`);
  }
  return body as T;
}

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Exchange a client's password for a project token. Throws on bad credentials. */
export async function signInProjects(email: string, password: string): Promise<string[]> {
  const params = await req<{ salt: string; iterations: number }>("/auth/params", {}, false);
  if (!params.salt) throw new ProjectsApiError(500, "Project sign-in is not configured");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(params.salt) as BufferSource, iterations: params.iterations },
    key,
    256,
  );
  const proof = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const res = await req<{ token: string; projects: string[] }>(
    "/auth",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: email, proof }) },
    false,
  );
  try {
    sessionStorage.setItem(CLIENT_TOKEN_KEY, res.token);
  } catch {
    /* the session will not survive a reload */
  }
  return res.projects;
}

export function listProjects(): Promise<{ user: string; admin: boolean; projects: { id: string; title: string }[] }> {
  return req("/projects");
}

export function fetchProject(id: string): Promise<ProjectDoc> {
  return req(`/projects/${encodeURIComponent(id)}`);
}

export type DeleteResult = { deleted: string; session: string; raw_objects: number; project_objects: number };

/**
 * Admins: delete one recording (a clip id or a sample session) from the project
 * and its raw take from the raw bucket. Recoverable from S3 versions for 90 days.
 */
export function deleteProjectItem(project: string, item: string): Promise<DeleteResult> {
  return req(`/projects/${encodeURIComponent(project)}/delete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ item }),
  });
}

/** A link to one of the project's files: opens through the Worker's redirect, valid while the grant is. */
export function projectFileUrl(doc: ProjectDoc, key: string, download = false): string {
  const q = new URLSearchParams({ p: doc.project, k: key, g: doc.grant });
  if (download) q.set("dl", "1");
  return `${ENDPOINT}/file?${q}`;
}
