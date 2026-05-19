//checker.js
require("dotenv").config();
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");

const { sendMail } = require("./sendMail");

const RESULTS_PATH = path.resolve(__dirname, "results.json");
const LOG_DIR = path.resolve(__dirname, "logs");
const SCREENSHOT_DIR = path.resolve(__dirname, "debug-screenshots");
const ACTIVITY_LOG = path.join(LOG_DIR, "activity.log");
const ERROR_LOG = path.join(LOG_DIR, "errors.log");
const IUMS_URL = process.env.IUMS_URL || "https://your-iums-url.com";
const IUMS_RESULTS_URL =
  process.env.IUMS_RESULTS_URL || "https://your-iums-url.com/results";

const SELECTORS = {
  username: process.env.IUMS_USERNAME_SELECTOR || "#username",
  password: process.env.IUMS_PASSWORD_SELECTOR || "#password",
  loginButton: process.env.IUMS_LOGIN_BUTTON_SELECTOR || "#loginButton",
  subject: process.env.IUMS_SUBJECT_SELECTOR || ".subject-name",
};

const RESULT_ACTION_SELECTORS = {
  semesterSelect: process.env.IUMS_SEMESTER_SELECTOR,
  showResultButton: process.env.IUMS_SHOW_RESULT_SELECTOR,
};

function normalizeSelector(value) {
  if (!value) {
    return value;
  }
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

const CREDS = {
  user: process.env.IUMS_USER || "YOUR_ID",
  pass: process.env.IUMS_PASS || "YOUR_PASSWORD",
};

let isRunning = false;
let cronTask = null;
let currentBrowser = null;
let lastCheckSuccessful = false;
let shutdownInitiated = false;

function ensureDirs() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }
}

function writeLog(filePath, message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  fs.appendFileSync(filePath, line);
}

function log(message, extra) {
  if (extra !== undefined) {
    console.log(`[IUMS] ${message}`, extra);
    writeLog(ACTIVITY_LOG, `[IUMS] ${message} ${JSON.stringify(extra)}`);
    return;
  }
  console.log(`[IUMS] ${message}`);
  writeLog(ACTIVITY_LOG, `[IUMS] ${message}`);
}

function logError(message, error) {
  const detail = error?.message || error || "Unknown error";
  console.error(`[IUMS] ${message}`, detail);
  writeLog(ERROR_LOG, `[IUMS] ${message} ${detail}`);
}

function loadResults() {
  if (!fs.existsSync(RESULTS_PATH)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(RESULTS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((entry) => {
        if (typeof entry === "string") {
          const parts = entry.split(" - ");
          return normalizeCourse(parts[0] || "", parts[1] || "");
        }

        if (entry && typeof entry === "object") {
          return normalizeCourse(entry.code || "", entry.title || "");
        }

        return null;
      })
      .filter((entry) => entry && entry.code && entry.title);
  } catch (error) {
    console.error("[IUMS] Failed to parse results.json:", error.message || error);
    return [];
  }
}

function saveResults(subjects) {
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(subjects, null, 2));
}

function shouldSkipRow(code, title) {
  const combined = `${code} ${title}`.toLowerCase();
  const skipKeywords = ["gpa", "cgpa", "remarks", "summary", "total", "result"];
  return skipKeywords.some((keyword) => combined.includes(keyword));
}

function normalizeCourse(code, title) {
  return {
    code: code.trim(),
    title: title.trim(),
  };
}

async function selectLatestSemester(page, selectorOverride) {
  const fallbackSelectors = [
    "select#semester_id",
    "select[ng-model*='semester']",
    "select[ng-model*='sem']",
    "select[name*='sem']",
    "select[id*='sem']",
    "select",
  ];

  const selector =
    selectorOverride ||
    normalizeSelector(RESULT_ACTION_SELECTORS.semesterSelect) ||
    fallbackSelectors.join(", ");
  const dropdown = page.locator(selector).first();

  await dropdown.waitFor({ state: "attached", timeout: 60000 });
  await dropdown.scrollIntoViewIfNeeded();

  const options = dropdown.locator("option");
  const optionCount = await options.count();
  if (optionCount === 0) {
    log("Semester dropdown has no options. Skipping selection.");
    return;
  }

  const lastIndex = optionCount - 1;
  const lastValue = await options.nth(lastIndex).getAttribute("value");
  const lastLabel = await options.nth(lastIndex).innerText();

  if (lastValue) {
    await dropdown.selectOption(lastValue);
    log("Selected latest semester", lastLabel.trim());
    return;
  }

  log("Latest semester option has no value. Selection skipped.");
}

async function clickShowResult(page) {
  const fallbackSelector = 'button:has-text("Show Result"), a:has-text("Show Result")';
  const selector =
    normalizeSelector(RESULT_ACTION_SELECTORS.showResultButton) || fallbackSelector;
  const button = page.locator(selector).first();

  await button.waitFor({ state: "visible", timeout: 60000 });
  log("Show Result button detected");
  await button.click({ force: true });
  log("Show Result clicked");
}

async function waitForSemesterDropdown(page) {
  const selector = normalizeSelector(RESULT_ACTION_SELECTORS.semesterSelect) || "#semester_id";
  log("Waiting for Angular render...");
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(5000);

  await page.waitForSelector("#leftDiv, .panel.panel-green", { state: "attached", timeout: 60000 });
  await page.waitForSelector(selector, { state: "attached", timeout: 60000 });
  try {
    await page.waitForSelector(selector, { state: "visible", timeout: 15000 });
  } catch (error) {
    log("Semester dropdown attached but not visible yet; continuing");
  }
  log("Semester dropdown detected");
  return selector;
}

async function retryGradeSheetLoad(page) {
  log("Retrying gradeSheet load...");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(5000);
}

async function openGradeSheet(page) {
  await page.goto(IUMS_RESULTS_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForLoadState("networkidle");

  const resultMenu = page.locator(
    'a[data-ui-sref="gradeSheet"], a[href="#/gradeSheet"], a:has-text("Result")'
  ).first();

  if (await resultMenu.count()) {
    await resultMenu.click({ force: true });
    log("Clicked Result menu");
  }

  await page.waitForURL(/#\/gradeSheet/, { timeout: 60000 });
  log("GradeSheet route active");
}

async function extractCoursesFromRows(page, rowSelector) {
  const rows = page.locator(rowSelector);
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

    if (shouldSkipRow(code, title)) {
      continue;
    }

    courses.push(normalizeCourse(code, title));
  }

  log("Extracted course codes", courses.map((course) => course.code));
  log("Extracted course titles", courses.map((course) => course.title));
  log("Final cleaned subjects", courses.map((course) => `${course.code} - ${course.title}`));

  return courses;
}

async function checkResults() {
  if (isRunning) {
    log("Previous run still active. Skipping this cycle.");
    return;
  }

  isRunning = true;
  log("Checking results...");

  let browser;
  lastCheckSuccessful = false;

  try {
    browser = await chromium.launch({ headless: false });
    currentBrowser = browser;
    log("Browser started");

    const page = await browser.newPage();
    await page.goto(IUMS_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle");
    log("Login page loaded");

    await page.fill(SELECTORS.username, CREDS.user);
    await page.fill(SELECTORS.password, CREDS.pass);
    await page.click(SELECTORS.loginButton);
    await page.waitForLoadState("networkidle");
    log("Login submitted");

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "logged-in.png"), fullPage: true });

    await openGradeSheet(page);
    log("Results page loaded");

    await page.waitForLoadState("domcontentloaded");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(5000);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "gradesheet-loaded.png"), fullPage: true });

    let semesterSelector;
    try {
      semesterSelector = await waitForSemesterDropdown(page);
    } catch (error) {
      await retryGradeSheetLoad(page);
      try {
        semesterSelector = await waitForSemesterDropdown(page);
      } catch (retryError) {
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, "gradesheet-loaded.png"), fullPage: true });
        const html = await page.content();
        fs.writeFileSync(path.join(LOG_DIR, "debug.html"), html, "utf-8");
        throw retryError;
      }
    }

    await selectLatestSemester(page, semesterSelector);

    const showResultSelector =
      normalizeSelector(RESULT_ACTION_SELECTORS.showResultButton) ||
      'button[data-ng-click="vm.getGradesheet()"]';
    await page.waitForSelector(showResultSelector, { state: "visible", timeout: 60000 });
    log("Show Result button detected");
    await clickShowResult(page);
    await page.waitForLoadState("networkidle");

    const subjectSelector = normalizeSelector(SELECTORS.subject);
    await page.waitForSelector(subjectSelector, { state: "visible", timeout: 60000 });
    log("Result table detected");

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "result-table-loaded.png"), fullPage: true });

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "result-table.png"), fullPage: true });

    const courses = await extractCoursesFromRows(page, subjectSelector);

    log("Published subjects found", courses.map((course) => `${course.code} - ${course.title}`));
    log("Extracted subjects", courses);

    const oldResults = loadResults();
    const oldKeys = new Set(
      oldResults.map((course) => `${course.code}||${course.title}`)
    );

    const newCourses = courses.filter(
      (course) => !oldKeys.has(`${course.code}||${course.title}`)
    );

    if (newCourses.length === 0) {
      log("No new subjects detected");
    }

    const updatedResults = [...oldResults];

    for (const course of newCourses) {
      const sent = await sendMail(course);
      const label = `${course.code} - ${course.title}`;
      if (sent) {
        updatedResults.push(course);
        log("Notification sent", label);
      } else {
        log("Notification failed", label);
      }
    }

    if (newCourses.length > 0) {
      saveResults(updatedResults);
      log("Results updated", updatedResults);
    }
    lastCheckSuccessful = true;
  } catch (error) {
    logError("Checker failed:", error);
  } finally {
    if (browser) {
      await browser.close();
      log("Browser closed");
    }
    currentBrowser = null;
    isRunning = false;
  }
}

function startScheduler() {
  if (cronTask) {
    log("Scheduler already running. Skipping duplicate start.");
    return;
  }
  log("Scheduler starting (every 10 minutes)");
  cronTask = cron.schedule("*/10 * * * *", () => {
    checkResults();
    const status = lastCheckSuccessful ? "last check successful" : "last check failed";
    log(`Bot alive | ${status}`);
  });
}

async function shutdown(reason) {
  if (shutdownInitiated) {
    return;
  }
  shutdownInitiated = true;
  log(`Shutdown requested: ${reason}`);

  if (cronTask) {
    cronTask.stop();
    cronTask = null;
    log("Scheduler stopped");
  }

  if (currentBrowser) {
    try {
      await currentBrowser.close();
      log("Browser closed during shutdown");
    } catch (error) {
      logError("Failed to close browser during shutdown:", error);
    }
  }
  process.exit(0);
}

process.on("uncaughtException", (error) => {
  logError("Uncaught exception:", error);
});

process.on("unhandledRejection", (error) => {
  logError("Unhandled rejection:", error);
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

ensureDirs();
log("Bot starting up");
startScheduler();
checkResults();