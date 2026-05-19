// debugSelectors.js
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const SCREENSHOT_DIR = path.resolve(__dirname);

const ENV_KEYS = [
  "IUMS_URL",
  "IUMS_RESULTS_URL",
  "IUMS_USER",
  "IUMS_PASS",
  "IUMS_USERNAME_SELECTOR",
  "IUMS_PASSWORD_SELECTOR",
  "IUMS_LOGIN_BUTTON_SELECTOR",
  "IUMS_SUBJECT_SELECTOR",
];

const CONFIG = {
  iumsUrl: process.env.IUMS_URL,
  resultsUrl: process.env.IUMS_RESULTS_URL,
  user: process.env.IUMS_USER,
  pass: process.env.IUMS_PASS,
  pause: process.env.DEBUG_PAUSE !== "false",
  selectors: {
    username: process.env.IUMS_USERNAME_SELECTOR,
    password: process.env.IUMS_PASSWORD_SELECTOR,
    loginButton: process.env.IUMS_LOGIN_BUTTON_SELECTOR,
    subject: process.env.IUMS_SUBJECT_SELECTOR,
  },
};

function log(message, extra) {
  if (extra !== undefined) {
    console.log(`[DEBUG] ${message}`, extra);
    return;
  }
  console.log(`[DEBUG] ${message}`);
}

function warn(message, extra) {
  if (extra !== undefined) {
    console.warn(`[WARN] ${message}`, extra);
    return;
  }
  console.warn(`[WARN] ${message}`);
}

function errorLog(message, extra) {
  if (extra !== undefined) {
    console.error(`[ERROR] ${message}`, extra);
    return;
  }
  console.error(`[ERROR] ${message}`);
}

function validateEnv() {
  const missing = ENV_KEYS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    warn("Missing environment variables:", missing);
  } else {
    log("All required environment variables are present");
  }
}

function logEnvStatus() {
  log("Env loaded: IUMS_USER", Boolean(CONFIG.user));
  log("Env loaded: IUMS_PASS", Boolean(CONFIG.pass));
  log("Env loaded: username selector", Boolean(CONFIG.selectors.username));
  log("Env loaded: password selector", Boolean(CONFIG.selectors.password));
  log("Env loaded: login button selector", Boolean(CONFIG.selectors.loginButton));
  log("Env loaded: subject selector", Boolean(CONFIG.selectors.subject));
  if (!CONFIG.selectors.username || !CONFIG.selectors.password || !CONFIG.selectors.loginButton) {
    warn("Selector values starting with '#' must be quoted in .env (e.g., IUMS_USERNAME_SELECTOR=\"#userName\")");
  }
}

async function waitForSelectorSafe(page, selector, label) {
  if (!selector) {
    errorLog(`Selector missing for ${label}`);
    return false;
  }

  try {
    await page.waitForSelector(selector, { timeout: 15000, state: "attached" });
    const isVisible = await page.locator(selector).first().isVisible();
    log(`Selector found for ${label}: ${selector}`);
    if (!isVisible) {
      warn(`Selector found but not visible for ${label}: ${selector}`);
    }
    return true;
  } catch (err) {
    errorLog(`Selector not found for ${label}: ${selector}`);
    return false;
  }
}

async function waitAndFill(page, selector, value, label) {
  const ok = await waitForSelectorSafe(page, selector, label);
  if (!ok) {
    return false;
  }

  if (!value) {
    warn(`${label} value is empty. Check .env for ${label}.`);
  }
  await page.fill(selector, value || "");
  log(`Filled ${label}`);
  return true;
}

async function waitAndClick(page, selector, label) {
  const ok = await waitForSelectorSafe(page, selector, label);
  if (!ok) {
    return false;
  }

  await page.locator(selector).first().click({ force: true });
  log(`Clicked ${label}`);
  return true;
}

async function dumpHtml(page, filename) {
  try {
    const html = await page.content();
    fs.writeFileSync(path.resolve(__dirname, filename), html, "utf-8");
    log(`Saved HTML dump: ${filename}`);
  } catch (err) {
    errorLog("Failed to save HTML dump", err.message || err);
  }
}

async function saveScreenshot(page, filename) {
  try {
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, filename),
      fullPage: true,
    });
    log(`Screenshot saved: ${filename}`);
  } catch (err) {
    errorLog(`Failed to save screenshot ${filename}`, err.message || err);
  }
}

async function scrapeSubjects(page) {
  const selector = CONFIG.selectors.subject;
  const ok = await waitForSelectorSafe(page, selector, "subject list");
  if (!ok) {
    await dumpHtml(page, "debug.html");
    return [];
  }

  const rows = page.locator(selector);
  const rowCount = await rows.count();
  log("Total course rows found", rowCount);

  const courses = [];

  for (let i = 0; i < rowCount; i += 1) {
    const row = rows.nth(i);
    const cells = row.locator("td");
    const cellCount = await cells.count();
    if (cellCount < 2) {
      continue;
    }

    const codeRaw = await cells.nth(0).innerText();
    const titleRaw = await cells.nth(1).innerText();
    const code = (codeRaw || "").trim();
    const title = (titleRaw || "").trim();

    if (!code || !title) {
      continue;
    }

    const combined = `${code} ${title}`.toLowerCase();
    const skipKeywords = ["gpa", "cgpa", "remarks", "summary", "total", "result"];
    if (skipKeywords.some((keyword) => combined.includes(keyword))) {
      continue;
    }

    courses.push({ code, title });
  }

  log("Extracted course codes", courses.map((course) => course.code));
  log("Extracted course titles", courses.map((course) => course.title));
  log("Final cleaned subjects", courses.map((course) => `${course.code} - ${course.title}`));
  log("Total subjects found", courses.length);

  return courses;
}

async function pauseForInspection(page, message) {
  if (!CONFIG.pause) {
    log("Pause skipped (DEBUG_PAUSE=false)");
    return;
  }
  if (page.isClosed()) {
    warn("Pause skipped because the page is closed");
    return;
  }
  log(message || "Pausing for manual inspection...");
  try {
    await page.pause();
  } catch (err) {
    warn("Pause failed (page closed)", err.message || err);
  }
}

async function logPageDiagnostics(page, label) {
  const currentUrl = page.url();
  log(`${label} URL`, currentUrl);

  try {
    const bodyText = await page.innerText("body");
    const snippet = bodyText.replace(/\s+/g, " ").slice(0, 400);
    log(`${label} visible text snippet`, snippet);
    if (bodyText.toLowerCase().includes("captcha")) {
      warn("Page contains CAPTCHA text. Login may require manual action.");
    }
  } catch (err) {
    warn("Unable to capture visible text snippet", err.message || err);
  }
}

async function holdOpen(page, reason) {
  if (!CONFIG.pause) {
    log("Hold open skipped (DEBUG_PAUSE=false)");
    return;
  }
  if (page.isClosed()) {
    warn("Hold open skipped because the page is closed");
    return;
  }
  log(reason || "Holding browser open for inspection (60s)...");
  try {
    await page.waitForTimeout(60000);
  } catch (err) {
    warn("Hold open failed (page closed)", err.message || err);
  }
}

async function runDebug() {
  validateEnv();
  logEnvStatus();

  if (!CONFIG.iumsUrl) {
    errorLog("IUMS_URL is missing. Aborting.");
    return;
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: false,
      slowMo: 200,
      devtools: true,
    });

    log("Browser launched");

    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(CONFIG.iumsUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForLoadState("networkidle");
    log("Login page loaded");

    await saveScreenshot(page, "login-page.png");
    await saveScreenshot(page, "before-fill.png");

    // Note: pause happens after login to avoid blocking auto-fill.
    const hasUser = await waitAndFill(
      page,
      CONFIG.selectors.username,
      CONFIG.user,
      "username"
    );
    const hasPass = await waitAndFill(
      page,
      CONFIG.selectors.password,
      CONFIG.pass,
      "password"
    );

    await saveScreenshot(page, "after-fill.png");
    if (hasUser) {
      log("Username filled");
    }
    if (hasPass) {
      log("Password filled");
    }

    const canClick = await waitAndClick(
      page,
      CONFIG.selectors.loginButton,
      "login button"
    );
    if (!canClick) {
      errorLog("Login click failed");
    }

    if (!hasUser || !hasPass || !canClick) {
      warn("Login selectors missing. Pausing for manual inspection.");
      await saveScreenshot(page, "after-login.png");
      await dumpHtml(page, "debug.html");
      await logPageDiagnostics(page, "Login failure");
      await pauseForInspection(page);
      await holdOpen(page, "Keeping browser open after login failure");
      return;
    }

    await page.waitForLoadState("networkidle");
    log("Login button clicked");
    log("Login successful (navigation attempt complete)");
    await logPageDiagnostics(page, "After login");

    await saveScreenshot(page, "after-login.png");
    await saveScreenshot(page, "logged-in.png");

    if (CONFIG.resultsUrl) {
      await page.goto(CONFIG.resultsUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await page.waitForLoadState("networkidle");
      log("Results page loaded via direct URL");
    } else {
      log("IUMS_RESULTS_URL missing. Navigate manually to the results page, then resume.");
      await pauseForInspection(page);
    }

    const showResultButton = page.locator('button:has-text("Show Result"), a:has-text("Show Result")');
    if (await showResultButton.count()) {
      await showResultButton.first().click({ force: true });
      await page.waitForLoadState("networkidle");
      log("Show Result clicked");
    }

    // Pause AFTER reaching the results page to allow manual inspection.
    await pauseForInspection(page, "Results page loaded. Inspect the table and resume when ready.");

    // Keep browser open for inspection even after resume.
    await holdOpen(page, "Keeping browser open after results load");

    await saveScreenshot(page, "results-page.png");
    await saveScreenshot(page, "result-table.png");

    await scrapeSubjects(page);

    log("Debug run complete. Browser will remain open for inspection.");
    await pauseForInspection(page, "Final pause. Close the browser when done.");
  } catch (err) {
    errorLog("Debug run failed", err.message || err);
  } finally {
    if (browser) {
      await browser.close();
      log("Browser closed");
    }
  }
}

runDebug();
