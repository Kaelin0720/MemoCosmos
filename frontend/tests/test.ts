import { test as base, expect } from "@playwright/test";
import { ONBOARDING_STORAGE_KEY } from "../src/lib/product";
// Unhandled local-API requests fail closed. Test fixtures register their specific
// routes afterwards; no browser test can accidentally fall through to a user vault.
export const test = base.extend<{ apiBoundary: void; welcomeCompleted: boolean }>({
  welcomeCompleted: [true, { option: true }],
  apiBoundary: [
    async ({ page, welcomeCompleted }, use) => {
      if (welcomeCompleted)
        await page.addInitScript((key) => {
          localStorage.setItem(key, "complete");
        }, ONBOARDING_STORAGE_KEY);
      await page.route(/^http:\/\/(?:127\.0\.0\.1|localhost):(?:8000|8009)\//, (route) =>
        route.abort("blockedbyclient"),
      );
      await use();
    },
    { auto: true },
  ],
});
export { expect };
export type { Page } from "@playwright/test";
export const frontendOrigin = `http://127.0.0.1:${process.env.YIHE_TEST_PORT ?? 3307}`;
