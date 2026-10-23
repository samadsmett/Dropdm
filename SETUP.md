# DropDM setup guide

About 30 minutes. No coding. You'll use three accounts: Instagram, Render (runs DropDM 24/7) and Meta for Developers (lets it talk to Instagram).

Meta and Render move their buttons around from time to time. If a label doesn't match exactly, look for the closest thing.

---

## Part 1: Prepare your Instagram (5 min, on your phone)

1. Make sure your account is a **Creator** or **Business** account: Settings → **Account type and tools**.
2. Allow tools to access your messages: Settings → **Messages and story replies** → **Message controls** → **Connected tools** → turn on **Allow access to messages**. Without this, DMs can't be sent.

## Part 2: Create your Meta app (10 min, on a computer)

1. Go to **developers.facebook.com** and log in with the Facebook account linked to your Instagram. Accept the developer terms if asked.
2. **My Apps** → **Create App**. Name it anything, like `My DropDM`.
3. For the use case, choose **Manage messaging & content on Instagram**. Skip connecting a business portfolio if offered. Finish creating the app.
4. Go to **Use cases** → **Customize** (next to the Instagram one) → **API setup with Instagram login**.
5. In section **1**, click **Add all required permissions**.
6. Add yourself as a tester: left menu → **App roles** → **Roles** → **Add people** → **Instagram Tester** → type your Instagram username → **Add**. Then accept the invite at **instagram.com/accounts/manage_access** → **Tester invites** → **Accept**.
7. Back on **API setup with Instagram login**, section **2** → **Add account** → log in to Instagram and approve → click **Generate token** → copy it somewhere safe.
8. At the top of that page, click **Show** next to **Instagram app secret** and copy it. Use this one, not the secret under App settings → Basic.

Keep the token and the secret private. Anyone with them can message from your account.

## Part 3: Deploy DropDM (5 min)

1. Click the **Deploy to Render** button in the [README](README.md). Sign up for Render with GitHub or email if asked.
2. Render shows the settings from `render.yaml`. Fill in the three blanks:
   - `ADMIN_PASSWORD`: a strong password you'll remember. It's your dashboard login.
   - `IG_APP_SECRET`: the secret from Part 2, step 8
   - `IG_ACCESS_TOKEN`: the token from Part 2, step 7
3. Click **Deploy** (or **Apply**) and add a payment card when asked. The first build takes a few minutes.
4. When the service says **Live**, open its address (like `dropdm-xxxx.onrender.com`). Log in with any username and your `ADMIN_PASSWORD`.
5. Go to the **Setup** tab and press **Connect account**. It should say **Connected as @yourname**.

## Part 4: Point Meta at DropDM (5 min)

1. In your dashboard's **Setup** tab, the **Webhook address** step shows a **Callback URL** and a **Verify token**, each with a copy button.
2. In Meta, **API setup with Instagram login** → section **3, Configure webhooks**: paste both, then **Verify and save**.
3. In the webhook fields list that appears, turn on **comments** and **messages**.
4. **App settings** → **Basic**: set **Privacy Policy URL** to `https://YOUR-DROPDM-ADDRESS/privacy` (DropDM hosts one for you), choose a **Category**, and **Save changes**.
5. **Publish** the app (the switch or button at the top of the dashboard). Until it's published, Instagram won't send comments from other people.

You can ignore sections 4 and 5 on that Meta page (business login and app review). They're for apps that other businesses log into. DropDM only runs on your own account.

## Part 5: Test, then go live (5 min)

1. Dashboard → **Automations** → **New automation**: **Comments**, **Any post or reel**, keyword `test`, any DM text. **Save automation**.
2. From a **different** Instagram account, comment `test` on one of your posts. Comments from your own account are ignored on purpose.
3. Open **Activity** and click **Refresh**. You should see "got the DM" with "Test mode: not actually sent". That means everything is wired up.
4. **Go live:** in Render → your service → **Environment**, delete `DRY_RUN` → **Save Changes**. Once it's **Live** again, the test-mode banner disappears and DMs really send.
5. Test once more from the other account. The person you tested with was already marked as "sent", so either use a different account or turn off **Only once per person** on that automation while testing.

---

## Day to day

- **Pause** an automation with its switch. **Edit** it by tapping it.
- **Try a message** at the bottom of Automations shows which automation would answer, without sending.
- **One specific post** automations win over **Any post** ones on that post.
- **Raise the hourly cap** with a `MAX_PER_HOUR` variable in Render (e.g. `500`). Over the cap, DMs queue and go out automatically.
- **Token renewal is automatic.** If it ever expires (for example, the server was off for 2 months), generate a new token in Meta, replace `IG_ACCESS_TOKEN` in Render, and press **Reconnect** in Setup.

## Updating DropDM

If you deployed from someone else's copy and want updates, fork the repo on GitHub and deploy from your fork. To update, sync your fork; Render redeploys automatically. Your automations and activity live on the disk and survive updates.

## If something isn't working

**The build fails mentioning `better-sqlite3` or `node-gyp`.**
Render is using a Node version that's too new. In Render → **Environment**, make sure `NODE_VERSION` is `22`, then **Manual Deploy** → **Clear build cache & deploy**.

**Render rejects the plan in `render.yaml`.**
Pick the smallest paid plan (0.5 CPU, 512 MB) when it asks. Don't pick Free: it sleeps and can't keep a disk.

**The deploy never goes Live (health check fails).**
In Render → **Settings** → **Health Checks**, set the path to `/health`.

**"Connect account" shows an error.**
The message comes straight from Instagram. Usually the token was copied incompletely, or it was generated before you added the permissions. Generate a new one (Part 2, step 7), replace `IG_ACCESS_TOKEN`, wait for Live, press Reconnect.

**Nothing shows up in Activity after a comment.**
Check in order: the Meta app is **published**; **comments** and **messages** are on under webhook fields; Setup says **Connected**; you commented from a different account; the keyword matches (use "Try a message").

**Activity says "didn't get the DM".**
The reason is written under the entry. Permission errors: redo Part 2 steps 5–7 and Reconnect. "Outside of allowed window": the comment was older than 7 days. Messages blocked: recheck Part 1, step 2.

**See what the server is doing:** Render → your service → **Logs**.
