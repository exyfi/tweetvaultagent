# The reader profile

The single biggest quality lever in this system. Without it you get generic
summaries; with it you get a breakdown written for one person.

Store it in KV under the key `profile`:

```bash
wrangler kv key put --binding VAULT --remote profile "$(cat docs/PROFILE.md)"
```

It gets injected into the writer's system prompt in place of `{{PROFILE}}`.

## What to write

Four things, in plain sentences. Be blunt; nobody else reads this.

1. **Who you are and what you already know.** Lets the model skip explanations
   you don't need and use examples from your field.
2. **What you're actually trying to do**, with a deadline if you have one.
   Not "grow professionally". Something like "ship a paid product before March".
3. **Where you get stuck.** The real bottleneck, not the flattering one.
4. **Your constraints.** Time of day you work, budget, energy, health.

## Example

> Engineer, works a full-time job, wants to leave it. Strong on AI agents and
> orchestration, so technical examples need no simplification. Already built a
> working product but keeps polishing instead of launching: the bottleneck is
> shipping and selling, not building. Needs revenue within three months, moving
> countries in the autumn.
>
> Has ADHD. Fourteen years of planners and productivity systems never stuck.
> Saving a post feels like doing the task, which is how the backlog got to 2,000.
> Learning is more fun than selling, so skill bookmarks outnumber money
> bookmarks three to one. Works evenings, in fragments.
>
> How to use this: land posts about launching on the specific case (solo,
> evenings, no audience, no ad budget). If a post justifies "one more month of
> polish", say so out loud. For productivity posts, check against the planners
> that already failed instead of proposing another system. For skill posts, ask
> whether this brings the first paying customer closer or grows the collection.
> Never shame the backlog, never flatter.

## Rules that make it work

- Name the bottleneck the reader avoids naming. That line does the most work.
- Give the model permission to disagree with the post being reviewed.
- Keep it under 300 words. Longer profiles dilute the prompt.
- Rewrite it when your situation changes. A stale profile ages into noise.
