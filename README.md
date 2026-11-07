# session-strip

A Claude Code mod: a band above the prompt that helps you switch between your sessions in the desktop app.

- Shows your 12 most recent sessions in a grid, each with its name and age.
- A dot per session: ◐ Claude is working there, ● a reply arrived since you last looked, ○ seen. Sessions with ● come first.
- Click a session to open it. `hide` collapses the band, and it stays collapsed.
- The search box filters all your non-archived sessions by name, never inside chats.

Scheduled-task runs are hidden, and side chats fold into their parent. The mod runs locally: no model calls, no tokens.

It needs a Claude Code build with mods and the desktop app's Code tab, which provides the session list.

## Install

At the prompt of a terminal session:

```
/plugin install session-strip --marketplace asbasit/session-strip
```

Answer `y` to add the marketplace, then choose a scope.

From a shell:

```
claude plugin install session-strip --marketplace asbasit/session-strip
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `asbasit/session-strip`, then Add plugin.
