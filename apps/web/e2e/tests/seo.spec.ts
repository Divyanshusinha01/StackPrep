import { expect, test } from "../support/fixtures";

test.use({ storageState: { cookies: [], origins: [] } });

test("robots.txt allows the public site, blocks app routes and points at the sitemap", async ({ request, baseURL }) => {
  const response = await request.get("/robots.txt");
  expect(response.status()).toBe(200);
  const body = await response.text();
  expect(body).toMatch(/Allow: \/$/m);
  for (const path of ["/admin", "/workspaces", "/interviews", "/auth", "/github", "/status", "/login"]) {
    expect(body).toContain(`Disallow: ${path}`);
  }
  expect(body).toContain(`Sitemap: ${baseURL}/sitemap.xml`);
});

test("sitemap lists only the public pages with absolute URLs", async ({ request, baseURL }) => {
  const response = await request.get("/sitemap.xml");
  expect(response.status()).toBe(200);
  const locs = [...(await response.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  expect(locs).toEqual([`${baseURL}/`, `${baseURL}/privacy`, `${baseURL}/terms`]);
});

test("landing page has absolute canonical, Open Graph and JSON-LD metadata", async ({ page, baseURL }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("StackPrep · Turn your codebase into an interview");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${baseURL}`);
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", `${baseURL}`);
  const ogImage = await page.locator('meta[property="og:image"]').first().getAttribute("content");
  expect(ogImage?.startsWith(`${baseURL}/opengraph-image`)).toBe(true);

  const jsonLd = JSON.parse((await page.locator('script[type="application/ld+json"]').textContent()) ?? "{}");
  expect(jsonLd).toMatchObject({ "@type": "WebApplication", name: "StackPrep", url: baseURL });
});

for (const { path, heading } of [
  { path: "/privacy", heading: "Privacy Policy" },
  { path: "/terms", heading: "Terms of Service" },
]) {
  test(`${path} renders with its own title and canonical`, async ({ page, baseURL }) => {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page).toHaveTitle(`${heading} · StackPrep`);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${baseURL}${path}`);
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
  });
}

test("privacy policy states what is and is not retained", async ({ page }) => {
  await page.goto("/privacy");
  const main = page.getByRole("main");
  await expect(main).toContainText("Frames are analyzed and discarded");
  await expect(main).toContainText("Audio is streamed to the AI provider for real-time speech processing and is not retained");
  await expect(main.getByRole("heading", { name: "Deleting your data" })).toBeVisible();
});

test("footer and sign-in link to the legal pages", async ({ page }) => {
  await page.goto("/");
  const footer = page.getByRole("navigation", { name: "Footer" });
  await expect(footer.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
  await expect(footer.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");

  await page.goto("/login");
  await expect(page.getByText("By continuing you agree to the")).toBeVisible();
  await expect(page.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy");
  await expect(page.getByText("Frames analyzed, never stored")).toBeVisible();
});

test("security headers include the report-only CSP and COOP", async ({ request }) => {
  const response = await request.get("/");
  const headers = response.headers();
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["content-security-policy-report-only"]).toContain("connect-src 'self' https://api.openai.com");
  expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
});

test("not-found page offers a way home", async ({ page }) => {
  const response = await page.goto("/this-page-does-not-exist");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("link", { name: "Home", exact: true })).toHaveAttribute("href", "/");
});
