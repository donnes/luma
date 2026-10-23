# Luma voice

Ask about your T3 Code agents from your iPhone. Press the Action button, speak, and hear the answer.

1. An iOS Shortcut runs **Dictate Text**. Apple's speech recognition turns your words into text on the iPhone.
2. The Shortcut posts the text to this service on your PC.
3. The service asks OpenAI which of its tools to use, runs it against T3 Code, and answers in a sentence or two.
4. The Shortcut speaks the answer.

The service can:

- Summarize your agents: what needs you, what's working, what finished or failed.
- Reply to a thread you name, as if you typed it in T3 Code.
- Answer a pending question, or approve or deny a pending request.

Approvals always wait for your yes. So do replies and answers once the assistant has read anything from your threads in the last few minutes, since an agent's message could try to steer it. Luma then reads back the exact thread and message, and acts only if your next press is a plain yes: "yes", "yeah", "yep", "sure", "confirm", "do it" or "go ahead". Anything else cancels it. The service checks the yes itself; the model can't confirm anything. Luma reads an approval's command word for word, so a command that's long, spans several lines or has code in it can only be approved in T3 Code. You can still deny it by voice. If you ask again before Luma answers, only the last question it asked can be confirmed.

It can't run commands, start threads or control the TV. Those requests get a spoken "I can't do that yet".

## Set up the PC

Run these from the Luma checkout on the PC that runs T3 Code. They need Node.js 22+ and `pnpm install`.

### 1. Add your OpenAI key

Create `~/.config/luma/voice.env`, readable only by you:

```sh
mkdir -p ~/.config/luma
install -m 600 /dev/null ~/.config/luma/voice.env
$EDITOR ~/.config/luma/voice.env
```

```sh
OPENAI_API_KEY=sk-...
# Optional, with their defaults:
# LUMA_VOICE_MODEL=gpt-6-luna
# LUMA_VOICE_REASONING=low       # empty for models without reasoning
# LUMA_VOICE_HOST=127.0.0.1
# LUMA_VOICE_PORT=3780
# OPENAI_BASE_URL=https://api.openai.com/v1
```

`OPENAI_API_KEY` in the environment also works and wins over the file. The service never prints or logs the key. Requests go to OpenAI with `store: false`.

### 2. Pair with T3 Code

In T3 Code, open **Settings → Connections** and create a pairing link. Then run, within 5 minutes:

```sh
pnpm voice pair 127.0.0.1:3773 K7QM4XR2HP9D
# or the whole link:
pnpm voice pair "http://127.0.0.1:3773/pair#token=K7QM4XR2HP9D"
```

This creates a 30-day session named "Luma Voice" and saves it to `~/.config/luma/voice-pairing.json` (mode 600). Revoke it in T3 Code's Connections settings. When it expires, Luma says so; pair again the same way. The running service picks up a new pairing without a restart.

### 3. Run the service

```sh
pnpm voice
```

The first run creates the Shortcut's token in `~/.config/luma/voice-token` (mode 600) and prints it. `pnpm voice token` prints it again. The service listens on `http://127.0.0.1:3780/voice`, so only this PC can reach it until you expose it below.

To keep it running in the background, see the optional systemd user unit in [`luma-voice.service`](luma-voice.service). It isn't installed for you.

### 4. Reach it from the iPhone with Tailscale

The iPhone needs the Tailscale app, signed in to the same tailnet and connected. On the PC, check what Tailscale already serves, then add an HTTPS port for Luma voice:

```sh
tailscale serve status
tailscale serve --bg --https=8443 http://127.0.0.1:3780
```

Port 8443 leaves anything already on 443, like T3 Code, alone. Your Shortcut URL is then `https://<pc-name>.<tailnet>.ts.net:8443/voice`; `tailscale serve status` shows the name. Undo it with `tailscale serve --https=8443 off`.

Tailscale Serve only reaches devices on your tailnet. Don't use `tailscale funnel`, which would put the service on the public internet.

## Build the Shortcut

In the Shortcuts app on the iPhone, tap **+** and name the shortcut "Luma". Add these actions in order.

1. **Dictate Text.** Pick your language and set **Stop Listening** to **After Pause**.
2. **Get Contents of URL.**
   - URL: `https://<pc-name>.<tailnet>.ts.net:8443/voice`
   - Tap the arrow to show more options. Set **Method** to **POST**.
   - Under **Headers**, add `Authorization` with the value `Bearer ` followed by the token from `pnpm voice token`.
   - Set **Request Body** to **JSON**. Add a **Text** field with key `text` and choose the **Dictated Text** variable as its value.
3. **Speak Text**, with **Contents of URL** as its input. Use **Show Result** instead if you'd rather read the answer.

The service answers in plain text, errors included, so the Shortcut always has something to say.

To bind it to the Action button, open **Settings → Action Button**, swipe to **Shortcut**, and choose **Luma**.

Try "What needs me?", "Tell the login thread to use the new token flow", or "Approve the deploy", then "Yes".

## Troubleshooting

- **"The Shortcut's token is wrong."** The Authorization header must be `Bearer <token>`, with one space.
- **"I can't reach T3 Code."** T3 Code isn't running, or the pairing points at an address that changed. Pair again.
- **"OpenAI rejected my API key."** Check `OPENAI_API_KEY` in `voice.env`, then restart the service.
- **"I couldn't reach OpenAI."** OpenAI failed or took more than 15 seconds. The service log has the status code.
- The Shortcut times out: check that the iPhone's Tailscale app is connected and `tailscale serve status` lists port 8443.

## How it works

`src/main.ts` holds the commands. `server.ts` checks the token and reads the request. `assistant.ts` keeps the last few turns for three minutes, so "yes" and "the second one" make sense, and turns failures into short spoken answers. `openai.ts` runs the Responses API loop with the three tools in `tools.ts`, which also decides what waits for a yes. `t3.ts` opens one T3 Code connection per request with Luma's own client from `src/agents`.
