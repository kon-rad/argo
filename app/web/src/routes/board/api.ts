import type {
  BoardAssignRequest, BoardCard, BoardCardDetail, BoardCardFilter, BoardCardResponse, BoardCardsResponse, BoardBoardsResponse, BoardFinishRequest,
  BoardFlagsRequest, BoardMoveRequest, BoardTagRequest, BoardToken, NewBoardCard,
} from '@secondbrain/contracts/board';
import { json, request, type Params } from '../../lib/http.js';
import type { EventPage, OrgMessage } from '../../lib/api.js';

export const boardApi = {
  boards: () => request<BoardBoardsResponse>('/board/boards'),
  cards: (filter: BoardCardFilter = {}) => request<BoardCardsResponse>('/board/cards', filter as Params),
  card: (id: string) => request<BoardCardDetail>(`/board/cards/${id}`),
  create: (card: NewBoardCard) => request<{ card: BoardCard; message: OrgMessage | null }>('/board/cards', undefined, json('POST', card)),
  comment: (id: string, body: string) => request<{ comment: BoardCardDetail['comments'][number] }>(`/board/cards/${id}/comment`, undefined, json('POST', { body })),
  assign: (id: string, body: BoardAssignRequest) => request<BoardCardResponse>(`/board/cards/${id}/assign`, undefined, json('POST', body)),
  move: (id: string, status: BoardMoveRequest['status'], note?: string) => request<BoardCardResponse>(`/board/cards/${id}/move`, undefined, json('POST', { status, note })),
  finish: (id: string, body: BoardFinishRequest) => request<BoardCardResponse>(`/board/cards/${id}/finish`, undefined, json('POST', body)),
  tag: (id: string, body: BoardTagRequest) => request<BoardCardResponse>(`/board/cards/${id}/project`, undefined, json('POST', body)),
  flags: (id: string, body: BoardFlagsRequest) => request<BoardCardResponse>(`/board/cards/${id}/flags`, undefined, json('POST', body)),
  link: (id: string, dependsOn: string) => request<{ ok: true }>(`/board/cards/${id}/link`, undefined, json('POST', { depends_on: dependsOn })),
  log: (id: string, offset: number) => request<EventPage>(`/board/cards/${id}/log`, { offset }),
  tokens: () => request<{ tokens: BoardToken[] }>('/board/tokens'),
  revokeToken: (id: number) => request<{ ok: true }>(`/board/tokens/${id}/revoke`, undefined, { method: 'POST' }),
};

export { BOARD_STATUSES } from '@secondbrain/contracts/board';
export type { BoardCard, BoardCardDetail, BoardCardFilter, BoardContract, BoardInfo, BoardStatus, BoardToken, NewBoardCard } from '@secondbrain/contracts/board';
