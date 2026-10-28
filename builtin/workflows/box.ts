/**
 * box: the box agent. Remote mode runs workflow agents in Upstash Boxes made from the box image; this sets the image
 * up, or adds what agents asked for (`legion-need`, passed on by the assistant). An agent in a box updates the
 * project's `.legion/box/provision.sh` (and `env.sh`), runs it, and warms the build; Legion checks the script once
 * more, then saves the box as the new image. Its steps always run in a box, whether remote mode is on or not.
 */
import { agent, box, git, sh, workflow, z } from 'legion';

const Input = z.object({
  requests: z
    .array(z.string())
    .default([])
    .describe('Tools or dependencies to add. None: set the image up for what the repository needs.'),
  verify: z
    .array(z.string())
    .default([])
    .describe('Commands that must pass in the box afterwards, e.g. the build or a quick test.'),
});

const Report = z.object({
  ok: z.boolean().describe('The script runs cleanly, every request is in, and the verify commands pass'),
  summary: z.string().describe('What the image now has, in two or three sentences'),
  added: z.array(z.string()).describe('What this run added, with versions'),
  problems: z.array(z.string()).describe('Requests that could not be met, and why'),
});

const BOX_AGENT = `You are the box agent. Every workflow agent of this project works in a remote Linux box (an Upstash Box: Debian, a user with passwordless sudo, apt, and the image's toolchain). You maintain the box image those boxes start from. You are in such a box now, in the repository.

The image is described by two files that you own:
- .legion/box/provision.sh: a bash script, run from the repository root, that installs everything the project needs: apt packages, language toolchains at the versions the project pins (rust-toolchain.toml, .nvmrc, .tool-versions, package.json engines, CI configs), CLIs, and the project's own dependencies (pnpm install, cargo fetch). It must be idempotent: when everything is in place it checks and finishes in seconds. Start it with \`set -euo pipefail\`, keep each tool in its own commented block, pin versions, and install into $HOME (e.g. $HOME/opt) or with sudo apt; never into the repository.
- .legion/box/env.sh: sourced before every command in a box (by every agent and every shell step): PATH and the variables the tools need. It must be fast, print nothing, and never fail (it is sourced in shells with set -e).

If the files exist, extend them; else write them from what the repository shows (its lockfiles, toolchain files, README and docs, CI configs, and any setup scripts it already has, e.g. under tools/ or scripts/: reuse them rather than rewriting).`;

export default workflow(
  {
    name: 'box',
    description:
      'The box agent (remote mode): set up or extend the box image every Upstash Box starts from (toolchain, dependencies, warm build). The assistant starts it with provision_box.',
    input: Input,
    example: { requests: ['ffmpeg (capture videos)'], verify: ['cargo build'] },
  },
  async ({ requests, verify }) => {
    const wt = await git.worktree('box');
    await box.prepare('files', wt);

    const asked = requests.length
      ? `Add to the image:\n${requests.map((r) => `- ${r}`).join('\n')}`
      : 'Set the image up for this repository: everything its build, tests and tools need.';
    const checks = verify.length
      ? `These must pass afterwards (with env.sh sourced):\n${verify.map((v) => `- ${v}`).join('\n')}`
      : 'Then build the project and run its quickest checks, as its README or CI does, so they work and the build caches are warm in the image.';
    const report = await agent('provision', {
      cwd: wt.path,
      tier: 'medium',
      system: BOX_AGENT,
      output: Report,
      prompt: `${asked}

1. Update .legion/box/provision.sh and .legion/box/env.sh for it.
2. Run \`bash .legion/box/provision.sh\` until it succeeds, then once more to check that a second run changes nothing and is quick.
3. In a new shell, source .legion/box/env.sh and check that each tool is found at the right version.
4. ${checks}

Change nothing outside .legion/box/ (build outputs and caches are fine). Do not commit. If something cannot be installed, say so in problems and leave it out of the script rather than leaving the script broken.`,
    });
    if (!report.ok) return { ok: false, report };

    await sh('again', 'bash .legion/box/provision.sh', { cwd: wt.path, label: 'provision.sh runs again cleanly' });
    for (const [i, command] of verify.entries()) {
      await sh(`verify-${i + 1}`, `. ./.legion/box/env.sh; ${command}`, { cwd: wt.path, label: `$ ${command}` });
    }
    const image = await box.snapshot('image', wt, { requests, summary: report.summary });
    return { ok: true, snapshot: image.snapshot, changedInYourCheckout: image.changed, report };
  },
);
