@AGENTS.md

@LEARNINGS.md

## Codex

You should often consult with codex. Codex is a special kind of subagent. You invoke it with the Bash tool, similar to how other subagents are invoked with the Task tool:
```
Bash(codex exec "prompt goes here")
```
Codex is my trusted senior engineer. When told you consult codex, you should not proceed until you get codex's signoff. By the way, Codex already knows the contents of AGENTS.md, so you don't need to tell it.

## Notes to user

```
META_DISABLE_SHAMAN=1 CLAUDE_CODE_VERSION_OVERRIDE=latest claude --dangerously-skip-permissions
```

Disable Meta plugins under ~/.claude/settings.json, enabledPlugins.
