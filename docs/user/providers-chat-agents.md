# Chat Agents

Chat Agents sends your messages to an ordinary ChatGPT chat in the ChatGPT desktop app on the
same machine as the T3 Code server. It uses W's desktop worker, the same one W's Telegram
service uses, so it needs W installed on that machine and its ChatGPT desktop app signed in.

## Turn it on

Open **Settings → Providers → Chat Agents** and switch it on. The paths already point at W's
install, so nothing else is needed. The status shows **Ready** when the worker and the ChatGPT
desktop app answer.

Pick **Chat Agents** from the model picker, or use it in a goal, like any other provider.

## What to expect

- **One chat per thread.** The first message opens a new ChatGPT chat. Later messages continue
  that chat, even after the server restarts.
- **The reply arrives all at once.** The worker returns when ChatGPT has finished, so you do not
  see text appear word by word or a list of tool calls. A reply can take minutes.
- **One message at a time.** All Chat Agents threads share one worker. Messages wait their turn
  rather than failing.
- **The chat has W's tools.** The ChatGPT chat can use the `@W` connector, so ask it to use W when
  you want it to start or check W work.
- **No attachments, titles or rollback.** Thread titles come from another provider.
- **Stop** ends the worker for that message and closes its window. If you delete the chat in
  ChatGPT, the next message starts a new one and says so.

**Most minutes per turn** (default 90) stops a message that ChatGPT has not finished by then.
