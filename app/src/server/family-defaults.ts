import "server-only";
import defaults from "@config/family-defaults.json";

/** Family bootstrap data (config/family-defaults.json) passed to register_app_user. */
export function getFamilyDefaults(): Record<string, unknown> {
  // The "$comment" key is documentation only.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { $comment, ...data } = defaults;
  return data;
}
