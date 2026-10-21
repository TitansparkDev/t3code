# Chat Agents

Chat Agents sends your messages to an ordinary ChatGPT chat in the ChatGPT desktop app on the
same machine as the T3 Code server. It uses W's desktop worker, the same one W's Telegram
service uses, so it needs W installed on that machine and its ChatGPT desktop app signed in.

## Turn it on

Chat Agents runs as a local ACP command, `t3 chat-agents-acp`, shown in **Settings → Providers**
as **Chat Agents**. A Chat Agents provider saved by an earlier version is converted when the
server starts, keeping its worker settings, and the command follows the server when it updates.
The defaults point at W's install, so nothing else is needed. The status shows **Ready** when the
worker and the ChatGPT desktop app answer.

Pick **Chat Agents** from the model picker, or use it in a goal, like any other provider.

## What to expect

- **One chat per thread.** The first message opens a new ChatGPT chat. Later messages continue
  that chat, even after the server restarts.
- **The reply arrives all at once.** The worker returns when ChatGPT has finished, so you do not
  see text appear word by word or a list of tool calls. A reply can take minutes.
- **One message at a time.** All Chat Agents threads share one worker. Messages wait their turn
  rather than failing.
- **The chat has the `@W` app's tools.** Every chat attaches the ChatGPT app named **W**. Point
  that app at this environment's MCP URL (see [outside agents](./outside-agents.md#chatgpt)) so the
  chat can use T3's tools. Goal overseers need this to read and act on escalations.
- **The desktop must be unlocked.** After a reboot without a desktop login, the keyring stays
  locked and the ChatGPT app cannot be driven. The provider then shows an error and goal
  overseers run on another provider.
- **No attachments, titles or rollback.** Thread titles come from another provider.
- **Stop** ends the worker for that message and closes its window. If you delete the chat in
  ChatGPT, the next message starts a new one and says so.

**Most minutes per turn** (default 90) stops a message that ChatGPT has not finished by then.
