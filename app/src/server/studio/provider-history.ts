import "server-only";
import type { StudioProject } from "@/lib/studio";
import { ProviderError } from "@/server/ai/types";
import { forFamily } from "@/server/db/family-scope";
import { StudioCapturedOutputError, studioFailureDiagnostic, studioFailureMessage } from "./diagnostics";

/** Interpret only fixed adapter prefixes; never reflect the stored provider message. */
export function legacyStudioProviderFailure(message: string): Error | null {
  if (/^openai network error: (TimeoutError|AbortError)$/.test(message)) return new ProviderError("", "openai", null, true, "timeout");
  if (/^openai network error:/.test(message)) return new ProviderError("", "openai", null, true, "network");
  const http = /^openai responses error (\d{3})$/.exec(message);
  if (http) return new ProviderError("", "openai", Number(http[1]), false, "http");
  const code = message.startsWith("openai response incomplete (") ? "STUDIO-AI-INCOMPLETE" : message.startsWith("openai structured output did not match the schema:") ? "STUDIO-AI-OUTPUT-SCHEMA" : message === "openai structured output was not valid JSON" ? "STUDIO-AI-JSON" : message === "openai response had no text output" ? "STUDIO-AI-NO-OUTPUT" : null;
  return code ? new StudioCapturedOutputError({ code, paths: [] }) : null;
}

/** Read-only recovery for old generic errors. Never infer or release money from an audit row. */
export async function studioDiagnosticFromHistory(familyId: string, id: string, project: StudioProject): Promise<StudioProject> {
  const diagnostic = project.failureDiagnostic;
  if (project.state !== "failed" || diagnostic?.code !== "STUDIO-PROCESSING" || project.pendingModelCall?.billed || !Number.isFinite(Date.parse(diagnostic.at))) return project;
  const role = ["analyze", "outline", "lesson_sources", "lesson_outline"].includes(project.phase) ? "studio.source" : ["plan", "author", "review"].includes(project.phase) ? `studio.${project.phase}_full` : `studio.${project.phase}`;
  try {
    const at = Date.parse(diagnostic.at);
    const { data, error } = await forFamily(familyId).select("ai_calls", "provider,error,created_at").eq("ref_table", "jobs").eq("ref_id", id).eq("role", role).eq("status", "error").eq("provider", "openai").gte("created_at", new Date(at - 30000).toISOString()).lte("created_at", new Date(at + 1000).toISOString()).order("created_at", { ascending: false }).limit(1).maybeSingle<{ provider: string; error: string | null; created_at: string }>();
    if (error || !data || data.provider !== "openai" || typeof data.error !== "string" || Date.parse(data.created_at) < at - 30000 || Date.parse(data.created_at) > at + 1000 || !Number.isFinite(Date.parse(data.created_at))) return project;
    const failure = legacyStudioProviderFailure(data.error);
    if (!failure) return project;
    const recovered = { ...studioFailureDiagnostic(failure, project.phase), at: diagnostic.at, provider: "openai", evidence: "provider_audit" as const };
    return { ...project, failureDiagnostic: recovered, error: studioFailureMessage(recovered, false) };
  } catch { return project; }
}
