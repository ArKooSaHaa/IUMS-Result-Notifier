# IUMS Result Notifier

Automates IUMS result checks and sends email notifications when new results are published.

## Features

- Scheduled result checks
- Gmail notifications via Nodemailer
- Playwright-based login and scraping
- Debug tools for selector discovery

## Requirements

- Node.js 18+
- A Gmail account with an app password

## Setup

1. Install dependencies:

   npm install

2. Create a `.env` file:

   EMAIL_USER=your-email@gmail.com
   EMAIL_PASS=your-app-password
   MAIL_FROM=your-email@gmail.com

3. Install Playwright system dependencies (Linux only):

   sudo npx playwright install-deps

## Configure Recipients

Update `MAILING_LIST` in sendMail.js with a comma-separated list of email addresses.

## Run Locally

- Start the checker (runs immediately and then every 10 minutes):

  npm run start

- Debug selectors:

  npm run dev

## PM2 (Production)

1. Install PM2:

   npm install -g pm2

2. Start with ecosystem config:

   pm2 start ecosystem.config.js

3. View logs:

   pm2 logs iums-bot

4. Restart or stop:

   pm2 restart iums-bot
   pm2 stop iums-bot

5. Auto-start after reboot:

   pm2 startup
   # Run the command PM2 prints, then:
   pm2 save

## NPM Scripts

- npm run start - start checker
- npm run dev - run debugSelectors
- npm run pm2:start - start PM2 process
- npm run pm2:stop - stop PM2 process
- npm run pm2:restart - restart PM2 process
- npm run pm2:logs - tail PM2 logs

## Logs & Screenshots

- Logs: ./logs/activity.log, ./logs/errors.log
- Debug HTML: ./logs/debug.html
- Screenshots: ./debug-screenshots/

## Notes

- The machine must stay powered on. If the laptop/server sleeps or shuts down, monitoring stops.

## Deployment Ideas

- VPS (Ubuntu)
- Railway
- Render
- Oracle Free Tier
- DigitalOcean
