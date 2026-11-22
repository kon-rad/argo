export type RequestStatus = 'submitted' | 'accepted' | 'rejected' | 'in_progress' | 'revision_requested' | 'completed' | 'cancelled';
export type DeskCategory = 'inbox' | 'active' | 'review' | 'closed';

/**
 * Places a marketplace request in one Hiring Desk view. Open work whose linked board card
 * reached review or done is waiting for the owner to review it before completing the request.
 */
export function categorizeRequest(status: RequestStatus, cardStatus: string | null): DeskCategory {
  switch (status) {
    case 'submitted': return 'inbox';
    case 'accepted': case 'in_progress': case 'revision_requested':
      return cardStatus === 'review' || cardStatus === 'done' ? 'review' : 'active';
    default: return 'closed';
  }
}
