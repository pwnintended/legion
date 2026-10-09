import { describe, expect, it } from 'vitest';
import { answeredInput, askedQuestions, questionsLabel, sentAnswers } from './user-input';

const claudeInput = {
  questions: [
    {
      question: 'Where does it fail?',
      header: 'Fails where',
      multiSelect: true,
      options: [
        { label: 'Board', description: 'The chat tiles' },
        { label: 'Code view', description: 'Terminals and the editor' },
      ],
    },
    { question: 'Which macOS?', header: 'OS', multiSelect: false, options: [{ label: '15', description: '' }] },
  ],
};

describe('askedQuestions', () => {
  it('reads Claude AskUserQuestion, keyed by question text, always with a free answer', () => {
    const questions = askedQuestions('AskUserQuestion', claudeInput);
    expect(questions?.map((q) => [q.key, q.header, q.multi, q.free, q.options.length])).toEqual([
      ['Where does it fail?', 'Fails where', true, true, 2],
      ['Which macOS?', 'OS', false, true, 1],
    ]);
  });

  it('reads Codex request_user_input, keyed by id', () => {
    const questions = askedQuestions('request_user_input', {
      questions: [
        {
          id: 'q1',
          header: 'Mode',
          question: 'Pick one',
          isOther: false,
          isSecret: false,
          options: [{ label: 'a', description: '' }],
        },
        { id: 'q2', header: 'Token', question: 'Paste it', isOther: false, isSecret: true, options: null },
      ],
    });
    expect(questions?.map((q) => [q.key, q.free, q.secret])).toEqual([
      ['q1', false, false],
      ['q2', true, true],
    ]);
  });

  it('is null for other tools', () => {
    expect(askedQuestions('Bash', { command: 'ls' })).toBeNull();
  });
});

describe('answeredInput', () => {
  it('gives Claude the questions back with one string answer per question', () => {
    const input = answeredInput('AskUserQuestion', claudeInput, {
      'Where does it fail?': ['Board', 'Code view'],
      'Which macOS?': ['15'],
    });
    expect(input).toEqual({
      ...claudeInput,
      answers: { 'Where does it fail?': 'Board, Code view', 'Which macOS?': '15' },
    });
    expect(sentAnswers('AskUserQuestion', input)).toEqual(['Board, Code view', '15']);
  });

  it('gives Codex its {answers: {id: {answers}}} shape', () => {
    const input = answeredInput('request_user_input', {}, { q1: ['a'], q2: ['secret'] });
    expect(input).toEqual({ answers: { q1: { answers: ['a'] }, q2: { answers: ['secret'] } } });
    expect(sentAnswers('request_user_input', input)).toEqual(['a', 'secret']);
  });
});

it('labels questions by the first header', () => {
  expect(questionsLabel(askedQuestions('AskUserQuestion', claudeInput) ?? [])).toBe('Fails where (+1 more)');
});
