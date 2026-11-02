import { AgentTask, CodePointer, ProjectConfig, TaskStatus } from '../models/types.js';
import { nowIso } from '../utils/time.js';
import type { CreateTaskInput } from './service.js';
import { TaskStore } from './tasks.js';

/** What the review desk needs from the service. */
export interface ReviewHost {
  readonly tasks: TaskStore;
  config(): Promise<ProjectConfig>;
  createTask(input: CreateTaskInput): Promise<AgentTask>;
  /** A TASK line in the journal only, not in any agent's history. */
  note(agentId: string, description: string, pointer?: CodePointer): Promise<void>;
}

/** Review gates: queues a panel for finished work, counts its votes and sends rejected work back. */
export class ReviewDesk {
  constructor(private readonly host: ReviewHost) {}

  /** Puts a review back in the queue when its agent died before judging. */
  async retryAbandoned(review: AgentTask, result?: string): Promise<void> {
    const { maxTaskAttempts } = await this.host.config();
    const now = nowIso();

    // A reviewer that dies every time it runs would otherwise requeue forever.
    if (maxTaskAttempts > 0 && review.attempts >= maxTaskAttempts) {
      review.result =
        `review abandoned after ${review.attempts} attempt(s): the agent ended without a verdict. ` +
        `Last output: ${result ?? 'none'}. The work is still unreviewed and needs a human decision.`;
      review.updatedAt = now;
      await this.host.tasks.write(review);
      return;
    }

    review.status = 'OPEN';
    review.claimedBy = undefined;
    review.claimedAt = undefined;
    review.claimExpiresAt = undefined;
    review.finishedAt = undefined;
    review.result = undefined;
    review.updatedAt = now;
    await this.host.tasks.write(review);

    await this.host.note(
      review.createdBy,
      `review ${review.id} ended without a verdict (${result ?? 'no output'}); back in the queue`,
      review.pointer
    );
  }

  /** Queues the reviews for one round of judging on `work`. */
  async queuePanel(
    work: AgentTask,
    round: number,
    createdBy: string,
    assignedTo: string | undefined,
    panel: number,
    objection?: string
  ): Promise<AgentTask[]> {
    const ordinal = round > 1 ? ` (round ${round})` : '';
    const previous = objection ? `The previous round rejected it: ${objection}. ` : '';

    const reviews: AgentTask[] = [];
    for (let seat = 1; seat <= panel; seat++) {
      const seatLabel = panel > 1 ? ` [${seat}/${panel}]` : '';
      reviews.push(
        await this.host.createTask({
          title: `Review${ordinal}${seatLabel}: ${work.title}`,
          detail:
            `Review the work of task ${work.id}. ${previous}Check it for real (read the code, ` +
            'run whatever can be run). Finish this review as DONE if it is correct, or ' +
            'FAILED with the reason, which sends the work back to the queue.' +
            (panel > 1
              ? ` You are one of ${panel} reviewers and the verdict is by majority, so judge on your own.`
              : ''),
          createdBy,
          // Left unassigned when the review is open: the queue hands it to whoever is free,
          // and claim() keeps it away from the agent that did the work.
          assignedTo,
          pointer: work.pointer,
          dependsOn: work.id,
          reviewOf: work.id,
          reviewRound: round,
          priority: work.priority
        })
      );
    }
    return reviews;
  }

  /** Applies a review verdict to the work it judged. */
  async settle(review: AgentTask, status: TaskStatus, result?: string): Promise<void> {
    if (!review.reviewOf) return;
    let work: AgentTask;
    try {
      work = await this.host.tasks.read(review.reviewOf);
    } catch {
      return; // The work was removed; nothing to settle.
    }
    const judge = review.claimedBy ?? review.createdBy;

    // With a panel, votes are counted within this review's own round.
    const round = review.reviewRound ?? 1;
    const panel = await this.panel(work.id, round);
    const seats = Math.max(panel.length, work.reviewers ?? 1);
    const approvals = panel.filter(seat => seat.status === 'DONE').length;
    const rejections = panel.filter(seat => seat.status === 'FAILED').length;
    const majority = Math.floor(seats / 2) + 1;
    // An even panel can split; a split counts as not approved.
    const allIn = approvals + rejections >= seats;

    if (approvals >= majority) {
      // Decided: cancel the seats that have not voted yet.
      await this.closeUndecided(panel, `majority already approved ${work.id} (${approvals}/${seats})`);
      await this.host.note(
        judge,
        seats > 1
          ? `review approved ${work.id} by majority (${approvals}/${seats}): ${work.title}`
          : `review approved ${work.id}: ${work.title}`,
        work.pointer
      );
      return;
    }

    if (rejections < majority && !allIn) return; // Still short of a decision; wait for the rest.

    if (rejections < majority) {
      result = `panel split ${approvals}-${rejections} with no majority; last objection: ${result ?? 'no reason given'}`;
    }
    await this.closeUndecided(panel, `majority already rejected ${work.id} (${rejections}/${seats})`);

    // Rejected: requeue the work with the reviewer's reason.
    const rounds = (work.reviewRounds ?? 0) + 1;
    const { maxReviewRounds } = await this.host.config();
    const now = nowIso();

    // Cap the rejections so a doer and a reviewer cannot loop forever.
    if (maxReviewRounds > 0 && rounds >= maxReviewRounds) {
      work.status = 'FAILED';
      work.reviewRounds = rounds;
      work.result =
        `review rejected it ${rounds} time(s) (limit maxReviewRounds=${maxReviewRounds}); ` +
        `last objection: ${result ?? 'no reason given'}. Needs a human decision.`;
      work.finishedAt = now;
      work.claimedBy = undefined;
      work.claimExpiresAt = undefined;
      work.updatedAt = now;
      await this.host.tasks.write(work);
      await this.host.note(
        judge,
        `review rejected ${work.id} ${rounds} time(s): stopped at the limit, waiting for a human decision`,
        work.pointer
      );
      return;
    }

    work.status = 'OPEN';
    work.claimedBy = undefined;
    work.claimedAt = undefined;
    work.claimExpiresAt = undefined;
    work.finishedAt = undefined;
    work.reviewRounds = rounds;
    work.result = `review rejected (${review.id}): ${result ?? 'no reason given'}`;
    work.detail = `${work.detail ?? ''}\n\nPREVIOUS REVIEW REJECTED: ${result ?? 'no reason given'}`.trim();
    work.updatedAt = now;
    await this.host.tasks.write(work);

    // Queue a new review round for the redone work.
    const next = await this.queuePanel(work, rounds + 1, review.createdBy, review.assignedTo, seats, result);
    work.reviewTaskId = next[0].id;
    work.updatedAt = nowIso();
    await this.host.tasks.write(work);

    await this.host.note(
      judge,
      `review rejected ${work.id} and sent it back to the queue (round ${rounds}): ${result ?? 'no reason given'}`,
      work.pointer
    );
  }

  /** Cancels the seats that have not voted once the outcome can no longer change. */
  private async closeUndecided(panel: AgentTask[], why: string): Promise<void> {
    for (const seat of panel) {
      if (seat.status === 'OPEN' || seat.status === 'CLAIMED') {
        await this.host.tasks.finish(seat.id, 'CANCELLED', why).catch(() => undefined);
      }
    }
  }

  /** The reviews making up one round's panel, in creation order. */
  private async panel(workId: string, round: number): Promise<AgentTask[]> {
    const all = await this.host.tasks.list();
    return all.filter(task => task.reviewOf === workId && (task.reviewRound ?? 1) === round);
  }
}
