/**
 * The subset of the app-server protocol Legion uses, typed with the generated bindings in `protocol/`
 * (codex-cli 0.160.0, `generate-ts --experimental`). Method names verified live.
 */
import type { InitializeParams, InitializeResponse, ServerNotification, ServerRequest } from './protocol';
import type {
  GetAccountParams,
  GetAccountResponse,
  ModelListParams,
  ModelListResponse,
  SkillsExtraRootsSetParams,
  SkillsExtraRootsSetResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
} from './protocol/v2';

export interface ClientMethods {
  initialize: [InitializeParams, InitializeResponse];
  'thread/start': [ThreadStartParams, ThreadStartResponse];
  'thread/resume': [ThreadResumeParams, ThreadResumeResponse];
  'turn/start': [TurnStartParams, TurnStartResponse];
  'turn/steer': [TurnSteerParams, TurnSteerResponse];
  'turn/interrupt': [TurnInterruptParams, TurnInterruptResponse];
  'account/read': [GetAccountParams, GetAccountResponse];
  'model/list': [ModelListParams, ModelListResponse];
  'skills/extraRoots/set': [SkillsExtraRootsSetParams, SkillsExtraRootsSetResponse];
}
export type ClientMethod = keyof ClientMethods;

export type { ServerNotification, ServerRequest };
export type ServerRequestMethod = ServerRequest['method'];
export type ServerRequestOf<M extends ServerRequestMethod> = Extract<ServerRequest, { method: M }>;
