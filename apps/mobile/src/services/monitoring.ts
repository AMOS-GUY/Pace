/**
 * Error reporting seam. Sentry is wired in at release preparation (M7) once a DSN exists;
 * until then errors are logged locally. Never include coordinates or personal data in context.
 */
export function reportError(
  error: unknown,
  context: { area: string; [key: string]: string | number | boolean },
): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[PACE:${context.area}] ${message}`);
}
