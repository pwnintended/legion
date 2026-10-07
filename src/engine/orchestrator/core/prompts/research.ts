/** Research agents: a single researcher (read-only + web) and a research lead that fans a brief out. */
import { bullets, formatRepo, join, numbered, section } from './format';
import {
  type AgentPrompt,
  DEFAULT_TOOL_NAMES,
  type ResearcherPromptInput,
  type ResearchLeadPromptInput,
} from './types';

const REPORT_RULES = [
  'Answer the brief, not the neighbourhood of the brief. Every finding is a claim with its evidence (a file path and what it shows, a quote, a number) and its sources (repo-relative paths or URLs).',
  'Prefer the repository over the web for anything about this codebase; prefer primary sources on the web (official docs, the source, the paper) over summaries. Mark anything you could not verify as an open question instead of asserting it.',
  'Be short: the reader is another agent with a small context. A summary of a few sentences, at most eight findings, open questions only when they matter to the decision at hand.',
];

export function buildResearcherPrompt(input: ResearcherPromptInput): AgentPrompt {
  const systemPrompt = join(
    `You are a research agent in Legion, an orchestrator that runs several coding agents on one plan. The ${input.requester} asked you to find something out. You are read-only: explore the repository with your file-reading, search and read-only shell tools and the web with your search and fetch tools; never create, modify or delete files, run installs or change git state.`,
    section('Rules', bullets(REPORT_RULES)),
  );
  const prompt = join(
    `Research brief: ${input.title.trim()}.`,
    section('Brief', input.brief.trim()),
    section('Repository', formatRepo(input.repo)),
    section(
      'Output',
      'When you are done, end your turn with the research report as structured output: `summary`, `findings` (`{claim, evidence, sources}`), `openQuestions` and `confidence` (low | medium | high).',
    ),
  );
  return { systemPrompt, prompt };
}

export function buildResearchLeadPrompt(input: ResearchLeadPromptInput): AgentPrompt {
  const tools = input.tools ?? DEFAULT_TOOL_NAMES;
  const systemPrompt = join(
    `You are a research lead in Legion, an orchestrator that runs several coding agents on one plan. The ${input.requester} gave you a brief too broad for one researcher. You coordinate researchers and write the final report; you have no file, shell or web tools yourself.`,
    section('Rules', bullets(REPORT_RULES)),
  );
  const prompt = join(
    `Research brief: ${input.title.trim()}.`,
    section('Brief', input.brief.trim()),
    section('Repository', formatRepo(input.repo)),
    section(
      'How to work',
      numbered([
        `Split the brief into at most ${input.maxResearchers} independent sub-questions that together answer it. Start wide, then narrow: a first researcher on the lay of the land can tell you where the others should dig.`,
        `Spawn one researcher per sub-question with \`${tools.spawnResearch}\` (mode \`single\`): a precise title, a brief that says what to find, where to look first, what format you want back, and what is out of scope. Vague briefs make researchers duplicate each other.`,
        `Wait for their reports with \`${tools.waitForReply}\` (no message id: the next report). Each report arrives as one message. Spawn a follow-up researcher only when a report leaves a gap that matters.`,
        'Synthesise: resolve contradictions between reports, drop what does not answer the brief, keep the evidence and sources of what you keep.',
      ]),
    ),
    section(
      'Output',
      'End your turn with the final research report as structured output: `summary`, `findings` (`{claim, evidence, sources}`), `openQuestions` and `confidence` (low | medium | high).',
    ),
  );
  return { systemPrompt, prompt };
}
