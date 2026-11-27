import "server-only";
import { forFamily } from "@/server/db/family-scope";
export interface ModelDiagnosticRoute { role: string; primary_provider: string; primary_model: string; economy_provider: string | null; economy_model: string | null; fallback_provider: string | null; fallback_model: string | null; }
export interface ModelDiagnosticCall { role: string; provider: string; model: string; status: string; fallback_used: boolean; created_at: string; }
export async function loadModelDiagnostics(familyId: string) {
  const scope = forFamily(familyId);
  const [routes, calls] = await Promise.all([
    scope.select("model_routes", "role,primary_provider,primary_model,economy_provider,economy_model,fallback_provider,fallback_model").order("role").returns<ModelDiagnosticRoute[]>(),
    scope.select("ai_calls", "role,provider,model,status,fallback_used,created_at").order("created_at", { ascending: false }).limit(20).returns<ModelDiagnosticCall[]>(),
  ]);
  return { routes: routes.error ? null : routes.data ?? [], calls: calls.error ? null : calls.data ?? [] };
}
