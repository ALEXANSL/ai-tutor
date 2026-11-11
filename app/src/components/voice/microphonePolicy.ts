"use client";
/** Permissions Policy belongs to the document, not to the current SPA pathname. */
export function documentAllowsMicrophone(doc: Document = document): boolean | undefined {
  const policy = doc as Document & { permissionsPolicy?: { allowsFeature(name: string): boolean }; featurePolicy?: { allowsFeature(name: string): boolean } };
  try { return (policy.permissionsPolicy ?? policy.featurePolicy)?.allowsFeature("microphone"); } catch { return undefined; }
}
