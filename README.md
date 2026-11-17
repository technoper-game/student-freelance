# student-freelance

## Local setup

Install dependencies with `npm install`, then configure these environment variables before starting the server:

- `JWT_SECRET`: a randomly generated secret with at least 32 characters.
- `GMAIL_EMAIL` and `GMAIL_APP_PASSWORD`: Gmail account and app password used for verification and password-reset emails.
- `APP_BASE_URL`: the public HTTPS base URL users visit (for example, `https://market.example.com`); use `http://localhost:3000` for local testing.
- `ADMIN_EMAIL` and `ADMIN_PASSWORD`: administrator account to seed at startup. The password must be at least 12 characters. The old built-in administrator account is removed at startup.
- `ESCROW_UPI_ID`: the verified UPI ID shown to buyers for escrow transfers.
- `PUPPETEER_EXECUTABLE_PATH`: optional Chrome/Chromium executable path when Puppeteer cannot find a browser automatically.

The WhatsApp client must be connected before registration can send phone-verification codes. On first startup, scan the QR code printed in the server terminal. Keep the WhatsApp authentication files private and persistent between restarts.