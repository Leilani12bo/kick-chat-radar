# Kick Chat Radar

A hosted Node/Express dashboard for `kick.com/deenthegreat`. It receives official Kick `chat.message.sent` webhook events, streams them to open dashboard tabs using Server-Sent Events, highlights configurable keywords, and plays a browser sound on matches.

## Important: not connected until configured

The code is ready to deploy, but it cannot receive this channel's messages until you create a Kick developer app, configure its public webhook URL, and add the app credentials and broadcaster user ID to your host. Never paste your Kick client secret into the browser or chat.

## Deploy on Render

1. Create a GitHub repository and upload the contents of this folder.
2. In Render, create **New + → Web Service**, connect that repository, and use:
   - Build command: `npm install`
   - Start command: `npm start`
3. Deploy. Copy the public HTTPS URL Render gives you, e.g. `https://your-radar.onrender.com`.
4. In the Render service's **Environment** settings, add:
   - `APP_BASE_URL` = your exact Render HTTPS URL
   - `CHANNEL_SLUG` = `deenthegreat`
   - `KICK_CLIENT_ID` = your Kick app client ID
   - `KICK_CLIENT_SECRET` = your Kick app client secret
   - `KICK_BROADCASTER_USER_ID` = the numeric broadcaster user ID for deenTheGreat
5. Redeploy after setting variables.

## Configure Kick

1. Open Kick account settings → Developer (create an app if you do not have one).
2. Enable Webhooks and set the webhook URL to:
   `https://YOUR-APP.onrender.com/webhooks/kick`
3. Save the webhook URL.
4. Find the numeric broadcaster user ID for `deenTheGreat` from the Kick Public API channel lookup in the Kick API docs / Swagger UI and put it in `KICK_BROADCASTER_USER_ID`.
5. Open your deployed dashboard and click **Set up Kick chat subscription**. The server requests an app access token and subscribes to `chat.message.sent` for that broadcaster.
6. Send a test message in the channel while it is live. The dashboard's status should show webhook events received.

Official docs:
- Kick developer API: https://docs.kick.com/
- Events/webhook setup: https://github.com/KickEngineering/KickDevDocs/blob/main/events/introduction.md
- Event types and chat payload: https://github.com/KickEngineering/KickDevDocs/blob/main/events/event-types.md
- Webhook signature validation: https://github.com/KickEngineering/KickDevDocs/blob/main/events/webhook-security.md

## Notes

- The dashboard's keyword list and colors are saved in the browser's local storage on that device.
- Sound requires one user click first (browser autoplay policy); use **Test alert sound** once after opening the page.
- This starter uses in-memory recent-message storage. On a free host, the service may sleep/restart and clear its recent message list. Keyword settings remain in the browser.
- Keep the Kick client secret only in Render environment variables. Do not commit `.env` or credentials.
- Official Kick webhook delivery requires a publicly accessible HTTPS URL. The server verifies each event using Kick's current public key before accepting it.
