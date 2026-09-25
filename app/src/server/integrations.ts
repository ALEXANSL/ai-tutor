import "server-only";

/**
 * Family integrations seam (ADR-018 K-5): code reads integration settings
 * ONLY through this function. In the MVP the values come from environment
 * variables of the single family; a SaaS version would read a table/Vault.
 * Used from S1 (Drive), S4 (e-mail, Telegram), S5 (alerts).
 */
export type IntegrationKind =
  | "drive_materials_folder"
  | "drive_archive_folder"
  | "alert_email"
  | "telegram_bot"
  | "air_alerts";

const ENV_BY_KIND: Record<IntegrationKind, string> = {
  drive_materials_folder: "GOOGLE_DRIVE_FOLDER_ID",
  drive_archive_folder: "GOOGLE_DRIVE_ARCHIVE_FOLDER_ID",
  alert_email: "ALERT_EMAIL_TO",
  telegram_bot: "TELEGRAM_BOT_TOKEN",
  air_alerts: "ALERTS_IN_UA_TOKEN",
};

export async function getFamilyIntegration(familyId: string, kind: IntegrationKind): Promise<string | null> {
  return process.env[ENV_BY_KIND[kind]]?.trim() || null;
}
