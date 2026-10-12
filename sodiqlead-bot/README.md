# SodiqSchool portal and Telegram bot

The app serves the site at `http://localhost:3000` and runs the confirmation bot `@SodiqLead_bot` in the same Node.js process.

## Start

Use Node.js 20 or newer. Keep the existing private values in `.env` and add `SODIQSCHOOL_ADMIN_TELEGRAM=ShindoTensei`. Do not share `.env` or paste its contents into chats. Run `npm start` in this folder.

## Student flow

- Registration asks for first name, last name and a class name available from the admin-managed list.
- The student sends the one-time code to `@SodiqLead_bot`.
- The browser detects confirmation, creates an HTTP-only session and opens the student portal automatically.
- Returning students use the same details, get a login code, then confirm it from the Telegram account already linked to their profile.
- Inside the portal, students can filter initiatives by text, category, class, status and date, sort by popularity, and see the three most-supported ideas. Voting stays open for 14 days after submission. Authors can edit ideas while they are under review and delete their own ideas. The class rating covers the last 14 days and counts students who proposed or supported ideas.
- Admins can move initiatives through “На рассмотрении”, “В работе” and “Реализовано”, add an explanation and delete inappropriate entries. When status or explanation changes, the bot sends the author a Telegram notification.
- Admins can edit or delete news and events. Events include date, time and place; signed-in users can RSVP with “Я пойду”. The admin panel displays school-wide totals for students, ideas, likes, posts and event attendance.

## Class administration

Only the Telegram account whose username matches `SODIQSCHOOL_ADMIN_TELEGRAM` receives the admin tab. The configured admin must register or log in by confirming the code from that Telegram account. Admins can publish news and events and manage custom class names such as `10Oxford` or `8Б-Экология`. Students cannot publish news or events; admins cannot submit student initiatives. A class assigned to a student cannot be deleted.

The app stores accounts, sessions, link codes, class names, news, events, initiatives, votes and attendance in `data.json` beside the server. The last 20 automatic snapshots are stored in `backups/` (excluded from Git). To restore one, stop the server and copy the selected snapshot over `data.json` before restarting. Keep both folders private: they contain account and session data. The API uses same-origin checks, HTTP-only session cookies, security headers and atomic writes. The bot uses Telegram long polling and native Node.js APIs; no third-party packages are required. This local JSON setup is a prototype and should be moved to a managed database before public deployment.
