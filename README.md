# DropDM

**Free, self-hosted Instagram auto-DM. The ManyChat core features, on your own server.**

Someone comments a keyword on your reel, they get your link in their DMs. No monthly subscription, no third party holding your followers' data.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/samadsmett/dropdm)

Built by [@samadsmett](https://instagram.com/samadsmett).

> **Don't want to set up a server and a Meta app?** A hosted version, where you just log in with Instagram, is in the works. **[Join the waitlist](https://quickreply-nsj2.onrender.com/waitlist)** and you'll hear first.

---

## What it does

- **Comment-to-DM.** Someone comments "prompt" on any post (or one specific reel) and gets your DM, with an optional public reply like "Sent! Check your DMs 📩".
- **Keyword DMs.** Auto-reply when someone DMs you a word, or anything at all.
- **Story replies.** Auto-reply when someone responds to your story.
- **DMs with a button link.** If Instagram ever refuses the button, it falls back to plain text with the link, so people still get it.
- **Once per person.** Repeat commenters don't get spammed.
- **A send queue for viral posts.** DMs are spaced out under an hourly cap. Anything over the cap waits and goes out automatically, so nothing is lost and your account stays safe.
- **Test mode.** Connect your real account and watch real comments come in, without sending anything, until you're ready.
- **Token auto-renewal.** Instagram tokens expire after 60 days. DropDM renews yours every week.
- **A dashboard that works on your phone.** Create automations with a live DM preview, see who got what, and test keywords without sending.

## What you need

- An Instagram **Creator** or **Business** account
- A free **Meta for Developers** account
- A **Render** account: about $7/month for an always-on server plus $0.25/month for storage (free servers fall asleep and miss comments)

About 30 minutes to set up. No coding.

## Get started

Follow **[SETUP.md](SETUP.md)**. It walks through every click: Instagram settings, the deploy button, your Meta app, and your first test.

## The rules Instagram enforces (for every tool, ManyChat included)

- You can only DM people who commented or messaged you first.
- One automatic DM per comment, within 7 days of the comment.
- Follow-up messages only within 24 hours of the person's last message.
- Automated messages are rate-limited per account. DropDM defaults to 180 per hour; you can raise it with `MAX_PER_HOUR` (staying under about 500 is sensible).

## How it works

```
Instagram ──webhook──▶ server.js ──match keyword──▶ queue ──▶ Instagram API (DM / reply)
                         │                                        │
                         └──── SQLite on your disk (automations, activity, dedupe) ◀─┘
```

| File | What it does |
|---|---|
| `server.js` | Receives Instagram events, matches keywords, runs the send queue, serves the dashboard |
| `instagram.js` | Talks to the Instagram API |
| `db.js` | Storage: one SQLite file in `DATA_DIR` |
| `public/index.html` | The dashboard |
| `render.yaml` | One-click deploy settings for Render |

### Environment variables

| Variable | Required | What it is |
|---|---|---|
| `ADMIN_PASSWORD` | Yes | Your dashboard login (any username works) |
| `VERIFY_TOKEN` | Yes | Any phrase. You paste the same one into Meta. The deploy button makes one for you |
| `IG_APP_SECRET` | Yes | "Instagram app secret" from your Meta app |
| `IG_ACCESS_TOKEN` | Yes | From "Generate token" in your Meta app |
| `DATA_DIR` | Yes | Where data is stored. Must be on a persistent disk (`/data` on Render) |
| `DRY_RUN` | No | `1` = test mode. Delete it to go live |
| `MAX_PER_HOUR` | No | DM cap per hour. Default 180 |
| `GRAPH_VERSION` | No | Instagram API version. Default `v25.0` |

Running elsewhere? Any host that runs Node 22 with a persistent disk works: `npm install`, then `npm start`.

## Privacy and security

- Your keys live in your host's environment variables, never in the code.
- Webhooks are checked against your app secret, so only real Instagram events are accepted.
- The dashboard is password-protected. Use a strong password.
- The only data stored is what's needed to avoid duplicate DMs: Instagram user IDs, usernames and the text that triggered a reply. It never leaves your server.

DropDM is an independent project. It isn't affiliated with or endorsed by Meta, Instagram or ManyChat. You're responsible for using it within [Meta's Platform Terms](https://developers.facebook.com/terms/) and Instagram's community guidelines.

## License

MIT. Use it, change it, share it. A credit back to [@samadsmett](https://instagram.com/samadsmett) is appreciated.
