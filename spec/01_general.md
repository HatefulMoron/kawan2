## Purpose

Kawan is a git based tool for development of software or other projects using
agents. Kawan uses `pi` internally for driving the agent loop.

### Comparison

#### Terminal multiplexers (Herdr et. al)

Pros

- Makes managing lots of agent sessions easier.
- Notifies user when agent sessions need input.

Cons

- Too low level. Creating worktrees, telling to write commits, reviewing the
  output, merging branches: all of these are left to the user to lay out in
  system prompt or AGENTS.md, or otherwise communicate within the session.

#### GitHub bots (dsh-superagent-prototype)

Pros

- Automated and doesn't require holding the agent's hand.
- Uses a standard interface (GitHub).
- Fixing bugs and implementing discrete features works very well.

Cons

- Epics and experimental work are not well supported. Have to create 'issues'
  which are vague or experimental, to create pull requests which start to
  resemble agent sessions themselves as users go back/forth with the bot and
  see the output. These sorts of issues trend toward a way to invoke the bot,
  PRs trend toward being terminal sessions of experimentation.
- Doesn't have a good way of talking to the agent in a bigger picture/general
  way, or starting tasks outside of issues.
- Mostly built more for accomplishing discrete tasks: fixing bugs, adding new
  dials, changing design elements, etc.

### Desired Properties

- High level: no worktrees or direct git operations. 
- Git based for managing state.
- Hosted on a single machine instance. That is to say, centralized on some
  VPS or machine on network that can be accessed elsewhere.
- Multiple users. Single tenant is fine.
- Host drives the agent sessions/work

### Not Desired Properties

- Multi machine, multi instance, federated, or horizontally scaled.
- Multi-tenant. This is not for some SaaS product.

